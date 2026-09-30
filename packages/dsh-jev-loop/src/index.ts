/**
 * Jev in the agent loop.
 *
 * Four gates, all automatic — the model never asks for them:
 *
 * - `agent/pre-step` judges the request before the first step and can inject a
 *   clarifying-question instruction.
 * - `tools/pre-execute` judges a tool call before it runs (destructive,
 *   exfiltration, off-task) and can allow, ask, or deny.
 * - `tools/post-execute` judges a successful result and can block it with
 *   corrective feedback.
 * - `agent/turn-stopping` judges the turn before it closes and, when the
 *   request looks unfinished, steers a nudge so the loop keeps working.
 *
 * Jev supplies the judgment; this plugin owns the thresholds, the decisions,
 * and the cost envelope. Every failure fails open: a judgment service that is
 * down must not take the agent loop with it.
 *
 * Each gate can be toggled at runtime through the `jevLoop` service this
 * plugin provides; moqi's `/JevLoop` panel is one consumer. The toggle state
 * persists to `$DSH_HOME/jev-loop.json`.
 * @module
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { JevClient, type Answer, type JevClientStats, type Question } from './jev.ts'
import { lastUserRequest, renderContent, renderMessages } from './render.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-jev-loop'

/** No services are required: the gates are pure event listeners. */
export const inject: string[] = []

/** The service key moqi looks up to render `/JevLoop`. */
export const JEV_LOOP_SERVICE = 'jevLoop'

/** The gates this plugin can run. */
export type GateName = 'preStep' | 'preExecute' | 'postExecute' | 'turnStopping'

/** One gate as the control surface sees it. */
export interface GateState {
  name: GateName
  label: string
  description: string
  enabled: boolean
  mode: string
}

/**
 * The control surface this plugin provides to any host.
 *
 * `moqi-jev-loop` consumes it to render `/JevLoop`; nothing here depends on
 * that host, so the core package mounts headless and unchanged.
 */
export interface JevLoopService {
  gates(): GateState[]
  toggle(name: GateName): GateState | undefined
  setEnabled(name: GateName, enabled: boolean): GateState | undefined
  stats(): JevClientStats
  /** Whether a key is resolvable right now (config, credential store, or env). */
  hasApiKey(): boolean
  /** Where the live key came from, for a control surface — never the value. */
  keySource(): string
  /** Store a key in the Harness credential store and start using it at once. */
  setApiKey(value: string): Promise<{ ok: boolean; error?: string }>
  /** Forget the stored key and stop judging until another is set. */
  clearApiKey(): Promise<{ ok: boolean; error?: string }>
}

/** Plugin config, resolved from the bundle patch or a profile layer. */
export interface Config {
  /** Literal key; prefer `apiKeyEnv` so no secret lives in a config file. */
  apiKey?: string
  /** Environment variable holding the key. Default `TYPESAFE_API_KEY`. */
  apiKeyEnv?: string
  /** TypeSafe model alias. Default `jev-latest`. */
  model?: string
  /** Evaluation endpoint. Default the public System One endpoint. */
  baseUrl?: string
  /** Per-request timeout in milliseconds. Default 3000. */
  timeoutMs?: number
  /** Retries on 429/529, network errors, and timeouts. Default 2. */
  maxRetries?: number
  /** Hard cap on the state characters sent to Jev. Default 24000. */
  maxStateChars?: number
  /** In-memory cache entries, keyed by the exact request body. Default 500. */
  cacheEntries?: number
  /** JSONL audit trail of every judgment. Default `$DSH_HOME/jev-loop.jsonl`. */
  auditPath?: string
  /** Where the runtime gate toggles persist. Default `$DSH_HOME/jev-loop.json`. */
  statePath?: string
  /** Judge the request before the first step. Default false. */
  preStepEnabled?: boolean
  /** Clarification probability at or above which a question is requested. Default 0.7. */
  preStepThreshold?: number
  /** Judge every tool call before dispatch. Default true. */
  preExecuteEnabled?: boolean
  /** `log` observes only, `ask` requests approval, `deny` refuses. Default `log`. */
  preExecuteMode?: string
  /** Hazard probability at or above which the call is flagged. Default 0.7. */
  preExecuteThreshold?: number
  /** Tool names to skip entirely. Default empty. */
  preExecuteSkip?: string[]
  /** Check a successful tool result before it is accepted. Default true. */
  postExecuteEnabled?: boolean
  /** `log` observes only, `block` turns corrective feedback into an error. Default `log`. */
  postExecuteMode?: string
  /** Failure probability at or above which a result is blocked. Default 0.7. */
  postExecuteThreshold?: number
  /** Check the turn before it closes. Default true. */
  turnStoppingEnabled?: boolean
  /** Completion probability below which the turn is nudged onward. Default 0.5. */
  turnStoppingThreshold?: number
  /** Most nudges per turn, so a wrong judgment cannot loop forever. Default 2. */
  turnStoppingMaxSteers?: number
  /** Most transcript messages fed to the completion judgment. Default 14. */
  turnStoppingMaxMessages?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  timeoutMs: z.number(),
  maxRetries: z.number(),
  maxStateChars: z.number(),
  cacheEntries: z.number(),
  auditPath: z.string(),
  statePath: z.string(),
  preStepEnabled: z.boolean(),
  preStepThreshold: z.number(),
  preExecuteEnabled: z.boolean(),
  preExecuteMode: z.string(),
  preExecuteThreshold: z.number(),
  preExecuteSkip: z.array(z.string()),
  postExecuteEnabled: z.boolean(),
  postExecuteMode: z.string(),
  postExecuteThreshold: z.number(),
  turnStoppingEnabled: z.boolean(),
  turnStoppingThreshold: z.number(),
  turnStoppingMaxSteers: z.number(),
  turnStoppingMaxMessages: z.number(),
})

/** The source stamped on every context this plugin injects or steers. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: name } as const

/** Declarative order and copy for the four gates. */
const GATE_META: readonly { name: GateName; label: string; description: string }[] = [
  { name: 'preStep', label: 'Pre-step', description: 'Judge the request · ask before guessing' },
  {
    name: 'preExecute',
    label: 'Pre-execute',
    description: 'Gate each tool call · destructive / exfiltration / off-task',
  },
  {
    name: 'postExecute',
    label: 'Post-execute',
    description: 'Check a tool result · block a silent failure',
  },
  {
    name: 'turnStopping',
    label: 'Turn-stopping',
    description: 'Nudge a turn that looks unfinished before it closes',
  },
]

/** One pre-execute question per hazard, asked together in a single call. */
const PRE_EXECUTE_QUESTIONS: Record<string, Question> = {
  destructive: {
    type: 'noul',
    instructions:
      'Does this tool call destroy, overwrite, or irreversibly modify data beyond what the user request needs?',
    criteria: {
      true: 'It destroys or irreversibly changes something the request did not ask for',
      false: 'It is read-only, additive, or clearly required by the request',
    },
  },
  exfiltration: {
    type: 'noul',
    instructions:
      'Does this tool call send credentials, secrets, or private user data to an external destination?',
    criteria: {
      true: 'Sensitive data leaves the machine or reaches a third party',
      false: 'No secrets or private data leave',
    },
  },
  offTask: {
    type: 'noul',
    instructions: 'Is this tool call unrelated to the user request shown above?',
    criteria: {
      true: 'It does something the request did not call for',
      false: 'It serves the request',
    },
  },
}

/** The result-audit question, asked after a call that reported success. */
const POST_EXECUTE_QUESTIONS: Record<string, Question> = {
  resultMissed: {
    type: 'noul',
    instructions:
      'Did this tool call fail to achieve what was intended, even though it reported success? Answer yes for empty or unchanged output, a wrong target, a silent no-op, or a result that contradicts the intent.',
    criteria: {
      true: 'The intended effect did not happen or is contradicted by the result',
      false: 'The result is consistent with the intended effect',
    },
  },
}

/** The first-step clarity question. */
const PRE_STEP_QUESTIONS: Record<string, Question> = {
  underspecified: {
    type: 'noul',
    instructions:
      'Does this request lack a detail that materially changes the work, such that acting without asking would likely be wrong?',
    criteria: {
      true: 'A missing detail changes the shape of the work; a focused question is warranted',
      false: 'The request is actionable; reasonable assumptions are safe',
    },
  },
}

/** The completion question the loop asks before it stops. */
const TURN_STOPPING_QUESTIONS: Record<string, Question> = {
  taskComplete: {
    type: 'noul',
    instructions:
      "Has the agent fully completed the user's most recent request? Answer yes only if every explicit part of the request is done and, where it matters, verified; answer no if anything asked for is missing, unverified, or failed.",
    criteria: {
      true: 'Every part of the request is done and verified',
      false: 'Some part is missing, unverified, or failed',
    },
  },
}

/** A resolved, defaulted, mutable view of {@link Config}. */
interface Settings {
  apiKey: string | undefined
  model: string
  baseUrl: string
  timeoutMs: number
  maxRetries: number
  maxStateChars: number
  cacheEntries: number
  auditPath: string
  statePath: string
  preStepThreshold: number
  preExecuteMode: 'log' | 'ask' | 'deny'
  preExecuteThreshold: number
  preExecuteSkip: Set<string>
  postExecuteMode: 'log' | 'block'
  postExecuteThreshold: number
  turnStoppingThreshold: number
  turnStoppingMaxSteers: number
  turnStoppingMaxMessages: number
}

/** A gate's live enabled flag and the copy the panel shows. */
interface RuntimeGate {
  name: GateName
  label: string
  description: string
  enabled: boolean
  mode: string
}

function resolveSettings(config: Config): Settings {
  const preExecuteMode =
    config.preExecuteMode === 'ask' || config.preExecuteMode === 'deny'
      ? config.preExecuteMode
      : 'log'
  const postExecuteMode = config.postExecuteMode === 'block' ? 'block' : 'log'
  const dshHome =
    process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
      ? process.env['DSH_HOME']
      : join(homedir(), '.dsh')
  const key = [
    config.apiKey,
    process.env[config.apiKeyEnv ?? 'TYPESAFE_API_KEY'],
    process.env['TYPESAFE_API_KEY'],
    process.env['TYPESAFE_APIKEY'],
  ].find((value) => value !== undefined && value !== '')
  return {
    apiKey: key,
    model: config.model ?? 'jev-latest',
    baseUrl: config.baseUrl ?? 'https://api.typesafe.ai/v1/systemone',
    timeoutMs: config.timeoutMs ?? 3000,
    maxRetries: config.maxRetries ?? 2,
    maxStateChars: config.maxStateChars ?? 24000,
    cacheEntries: config.cacheEntries ?? 500,
    auditPath: config.auditPath ?? join(dshHome, 'jev-loop.jsonl'),
    statePath: config.statePath ?? join(dshHome, 'jev-loop.json'),
    preStepThreshold: config.preStepThreshold ?? 0.7,
    preExecuteMode,
    preExecuteThreshold: config.preExecuteThreshold ?? 0.7,
    preExecuteSkip: new Set(config.preExecuteSkip ?? []),
    postExecuteMode,
    postExecuteThreshold: config.postExecuteThreshold ?? 0.7,
    turnStoppingThreshold: config.turnStoppingThreshold ?? 0.5,
    turnStoppingMaxSteers: config.turnStoppingMaxSteers ?? 2,
    turnStoppingMaxMessages: config.turnStoppingMaxMessages ?? 14,
  }
}

/** The config defaults for a gate, before the persisted override. */
function defaultEnabled(config: Config, gate: GateName): boolean {
  switch (gate) {
    case 'preStep':
      return config.preStepEnabled ?? false
    case 'preExecute':
      return config.preExecuteEnabled ?? true
    case 'postExecute':
      return config.postExecuteEnabled ?? true
    case 'turnStopping':
      return config.turnStoppingEnabled ?? true
  }
}

/** The mode a gate reports to the control surface. */
function gateMode(settings: Settings, gate: GateName): string {
  switch (gate) {
    case 'preExecute':
      return settings.preExecuteMode
    case 'postExecute':
      return settings.postExecuteMode
    case 'turnStopping':
      return 'nudge'
    case 'preStep':
      return 'clarify'
  }
}

/** Load the persisted gate overrides; a missing or broken file is empty. */
function loadOverrides(path: string): Partial<Record<GateName, boolean>> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      gates?: Partial<Record<GateName, boolean>>
    }
    return parsed.gates ?? {}
  } catch {
    return {}
  }
}

/** Persist the gate overrides; a failed write is not worth breaking over. */
function saveOverrides(path: string, gates: Map<GateName, RuntimeGate>): void {
  try {
    const out: Partial<Record<GateName, boolean>> = {}
    for (const [key, gate] of gates) out[key] = gate.enabled
    writeFileSync(path, `${JSON.stringify({ gates: out }, undefined, 2)}\n`)
  } catch {
    // Best effort only.
  }
}

/** Append one audit line; a failed write must never break the loop. */
function audit(path: string, entry: Record<string, unknown>): void {
  try {
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Best effort only.
  }
}

/** Every probability-answer as a plain map, for the audit line. */
function probabilities(answers: Record<string, Answer>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === 'noul') out[id] = answer.noul
  }
  return out
}

/** Hazards at or above the threshold, in question order. */
function hazardsAt(
  answers: Record<string, Answer>,
  threshold: number,
): { name: string; p: number }[] {
  const flagged: { name: string; p: number }[] = []
  for (const id of Object.keys(PRE_EXECUTE_QUESTIONS)) {
    const answer = answers[id]
    if (answer?.type === 'noul' && answer.noul >= threshold) {
      flagged.push({ name: id, p: answer.noul })
    }
  }
  return flagged
}

/** Serialize tool arguments for the judgment without ever throwing. */
function safeArguments(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return '[unserializable]'
  }
}

/** The context instruction injected when a request looks underspecified. */
function clarifyInstruction(probability: number): string {
  return [
    `A clarity check (Jev p=${probability.toFixed(2)}) judged this request underspecified.`,
    'Ask the user one focused question about the single most important missing detail, then stop and wait.',
    'Do not guess at the missing detail.',
  ].join(' ')
}

/** The corrective nudge steered when a turn looks unfinished. */
function unfinishedNudge(probability: number): string {
  return [
    `Before closing this turn: a completion check (Jev p=${probability.toFixed(2)}) judged the user's request not yet fully done.`,
    'Re-read the original request and the work above, then either finish the remaining part or state plainly what is still missing and why.',
    'Do not claim completion you have not verified.',
  ].join(' ')
}

/** The feedback that turns a silent failure into a retry. */
function resultFeedback(probability: number): string {
  return [
    `A result check (Jev p=${probability.toFixed(2)}) judged this tool call did not achieve what was intended, despite reporting success.`,
    'Inspect the actual output, retry with a corrected call, or explain plainly what failed.',
    'Do not treat this result as success.',
  ].join(' ')
}

/** The credential-store reference a panel-set key is stored under. */
const KEY_REF_NAME = 'TYPESAFE_API_KEY'

/** The slice of the Harness credential provider this plugin uses. */
interface CredentialLike {
  resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
  set(ref: unknown, value: string): Promise<void>
  unset(ref: unknown): Promise<void>
}

/** A cheap round-trip that proves a pasted key can reach the service. */
const PROBE_QUESTIONS: Record<string, Question> = {
  reachable: {
    type: 'noul',
    instructions: 'Does this state consist of the word "ok"?',
    criteria: { true: 'The state is basically ok', false: 'Anything else' },
  },
}

/** A message from an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mount the gates and provide the control service. */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(config)

  // Live gate state: config defaults, then the persisted overrides.
  const overrides = loadOverrides(settings.statePath)
  const gates = new Map<GateName, RuntimeGate>()
  for (const meta of GATE_META) {
    gates.set(meta.name, {
      name: meta.name,
      label: meta.label,
      description: meta.description,
      enabled: overrides[meta.name] ?? defaultEnabled(config, meta.name),
      mode: gateMode(settings, meta.name),
    })
  }
  const gateEnabled = (gate: GateName): boolean => gates.get(gate)?.enabled === true

  // The control service is always provided, so `/JevLoop` opens and the
  // toggles persist even when no key is configured and no judgment can run.
  let client: JevClient | undefined
  let keyStatus: { set: boolean; source: string } = { set: false, source: 'none' }

  /** Resolve the key: explicit config, then the credential store, then env. */
  const resolveKey = async (): Promise<{ value: string; source: string } | undefined> => {
    if (settings.apiKey !== undefined) return { value: settings.apiKey, source: 'config' }
    const credentials = ctx.get('credentials') as CredentialLike | undefined
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(credentialRef(KEY_REF_NAME))
        if (resolved !== undefined && resolved.value !== '') {
          return { value: resolved.value, source: `credential:${resolved.source}` }
        }
      } catch {
        // A failing store must not mask an environment key.
      }
    }
    for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_APIKEY']) {
      const value = process.env[name]
      if (value !== undefined && value !== '') return { value, source: `env:${name}` }
    }
    return undefined
  }

  const makeClient = (apiKey: string): JevClient =>
    new JevClient({
      apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
      maxStateChars: settings.maxStateChars,
      cacheEntries: settings.cacheEntries,
    })

  /** The live client, resolved from wherever the key lives; no key means none. */
  const ensureClient = async (): Promise<JevClient | undefined> => {
    if (client !== undefined) return client
    const resolved = await resolveKey()
    if (resolved === undefined) {
      keyStatus = { set: false, source: 'none' }
      return undefined
    }
    client = makeClient(resolved.value)
    keyStatus = { set: true, source: resolved.source }
    return client
  }

  const service: JevLoopService = {
    gates: () => [...gates.values()].map((gate) => ({ ...gate })),
    toggle: (gate) => {
      const found = gates.get(gate)
      if (found === undefined) return undefined
      found.enabled = !found.enabled
      saveOverrides(settings.statePath, gates)
      ctx.logger.info(`[dsh-jev-loop] ${gate} ${found.enabled ? 'enabled' : 'disabled'}`)
      return { ...found }
    },
    setEnabled: (gate, enabled) => {
      const found = gates.get(gate)
      if (found === undefined) return undefined
      found.enabled = enabled
      saveOverrides(settings.statePath, gates)
      return { ...found }
    },
    stats: () => client?.stats() ?? { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0 },
    hasApiKey: () => keyStatus.set,
    keySource: () => keyStatus.source,
    setApiKey: async (value) => {
      const trimmed = value.trim()
      if (trimmed === '') return service.clearApiKey()
      const credentials = ctx.get('credentials') as CredentialLike | undefined
      if (credentials === undefined) {
        return {
          ok: false,
          error: 'the Harness credential store is not mounted; set TYPESAFE_APIKEY instead',
        }
      }
      try {
        await credentials.set(credentialRef(KEY_REF_NAME), trimmed)
      } catch (error) {
        return { ok: false, error: describeError(error) }
      }
      const probe = makeClient(trimmed)
      const answer = await probe.systemOne('ok', PROBE_QUESTIONS)
      client = probe
      keyStatus = { set: true, source: 'credential:file' }
      audit(settings.auditPath, {
        gate: 'api-key',
        action: 'set',
        reachable: answer !== undefined,
      })
      if (answer === undefined) {
        return { ok: false, error: 'saved, but the TypeSafe API did not answer — check the key' }
      }
      return { ok: true }
    },
    clearApiKey: async () => {
      const credentials = ctx.get('credentials') as CredentialLike | undefined
      if (credentials !== undefined) {
        try {
          await credentials.unset(credentialRef(KEY_REF_NAME))
        } catch {
          // Removing an absent reference is a no-op anyway.
        }
      }
      client = undefined
      keyStatus = { set: false, source: 'none' }
      return { ok: true }
    },
  }
  ctx.provide(JEV_LOOP_SERVICE, service)

  // Resolve the key at mount so the panel shows its real state and an env or
  // stored key is live from the first gate.
  void ensureClient().then((active) => {
    if (active === undefined) {
      ctx.logger.warn(
        '[dsh-jev-loop] no TypeSafe API key yet; set one from moqi /JevLoop or TYPESAFE_APIKEY',
      )
    }
  })

  // A turn is nudged at most `turnStoppingMaxSteers` times, even across steps.
  const steerCounts = new Map<string, number>()
  // The pre-step judgment runs once per turn; later steps reuse the decision.
  const preStepJudged = new Set<string>()

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (!gateEnabled('preStep')) return next()
    const key = `${agent.session.id}:${String(turn)}`
    if (preStepJudged.has(key)) return next()
    const active = await ensureClient()
    if (active === undefined) return next()

    const state = renderMessages(
      agent.session.deriveMessages(),
      10,
      settings.maxStateChars,
    )
    const result = await active.systemOne(state, PRE_STEP_QUESTIONS, signal)
    // Judge a turn once even when the service is down, so a failure does not
    // cost one request per step.
    preStepJudged.add(key)
    if (preStepJudged.size > 500) preStepJudged.clear()
    if (result === undefined) {
      audit(settings.auditPath, { gate: 'agent/pre-step', outcome: 'no-answer', turn })
      return next()
    }
    const answer = result.answers['underspecified']
    const probability = answer?.type === 'noul' ? answer.noul : undefined
    const inject = probability !== undefined && probability >= settings.preStepThreshold
    audit(settings.auditPath, {
      gate: 'agent/pre-step',
      session: agent.session.id,
      turn,
      underspecified: probability,
      threshold: settings.preStepThreshold,
      action: inject ? 'inject' : 'pass',
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
    if (!inject || probability === undefined) return next()

    const reminder: UserMessage = createUserMessage({
      content: [{ type: 'text', text: clarifyInstruction(probability) }],
      source: PLUGIN_SOURCE,
    })
    return { kind: 'enter', messages: [...messages, reminder] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!gateEnabled('preExecute')) return next()
    if (settings.preExecuteSkip.has(exec.name)) return next()
    const active = await ensureClient()
    if (active === undefined) return next()

    const messages = exec.agent?.session.deriveMessages() ?? []
    const request = lastUserRequest(messages)
    const state = [
      request === undefined ? 'user: (no direct request yet)' : request,
      `tool: ${exec.name}`,
      `arguments: ${safeArguments(exec.arguments)}`,
    ].join('\n')

    const result = await active.systemOne(state, PRE_EXECUTE_QUESTIONS, exec.signal)
    if (result === undefined) {
      audit(settings.auditPath, {
        gate: 'tools/pre-execute',
        tool: exec.name,
        outcome: 'no-answer',
      })
      return next()
    }

    const flagged = hazardsAt(result.answers, settings.preExecuteThreshold)
    audit(settings.auditPath, {
      gate: 'tools/pre-execute',
      tool: exec.name,
      mode: settings.preExecuteMode,
      probabilities: probabilities(result.answers),
      flagged,
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })

    if (settings.preExecuteMode === 'log' || flagged.length === 0) return next()
    const reason = `Jev flagged this call (${flagged
      .map((hazard) => `${hazard.name}=${hazard.p.toFixed(2)}`)
      .join(', ')})`
    ctx.logger.warn(`[dsh-jev-loop] ${reason}: ${exec.name}`)
    return settings.preExecuteMode === 'deny'
      ? { kind: 'deny', reason }
      : { kind: 'ask', reason }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!gateEnabled('postExecute')) return next()
    // A result the harness already marked as an error needs no second opinion.
    if (result.isError === true) return next()
    const active = await ensureClient()
    if (active === undefined) return next()

    const messages = exec.agent?.session.deriveMessages() ?? []
    const request = lastUserRequest(messages)
    const state = [
      request === undefined ? 'user: (no direct request yet)' : request,
      `tool: ${exec.name}`,
      `arguments: ${safeArguments(exec.arguments)}`,
      `output: ${renderContent(result.content)}`,
    ].join('\n')

    const judged = await active.systemOne(state, POST_EXECUTE_QUESTIONS, exec.signal)
    if (judged === undefined) {
      audit(settings.auditPath, {
        gate: 'tools/post-execute',
        tool: exec.name,
        outcome: 'no-answer',
      })
      return next()
    }
    const answer = judged.answers['resultMissed']
    const probability = answer?.type === 'noul' ? answer.noul : undefined
    const block =
      settings.postExecuteMode === 'block' &&
      probability !== undefined &&
      probability >= settings.postExecuteThreshold
    audit(settings.auditPath, {
      gate: 'tools/post-execute',
      tool: exec.name,
      mode: settings.postExecuteMode,
      resultMissed: probability,
      threshold: settings.postExecuteThreshold,
      action: block ? 'block' : 'accept',
      cache: judged.cache,
      latencyMs: judged.latencyMs,
      usage: judged.usage,
    })
    if (!block || probability === undefined) return next()
    ctx.logger.warn(
      `[dsh-jev-loop] result for ${exec.name} looked wrong (p=${probability.toFixed(2)}); blocked`,
    )
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: resultFeedback(probability) }],
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!gateEnabled('turnStopping')) return
    const active = await ensureClient()
    if (active === undefined) return
    const state = renderMessages(
      agent.session.deriveMessages(),
      settings.turnStoppingMaxMessages,
      settings.maxStateChars,
    )
    const result = await active.systemOne(state, TURN_STOPPING_QUESTIONS, signal)
    if (result === undefined) {
      audit(settings.auditPath, {
        gate: 'agent/turn-stopping',
        session: agent.session.id,
        turn,
        outcome: 'no-answer',
      })
      return
    }

    const answer = result.answers['taskComplete']
    const probability = answer?.type === 'noul' ? answer.noul : undefined
    const key = `${agent.session.id}:${String(turn)}`
    const used = steerCounts.get(key) ?? 0
    let action: 'pass' | 'steer' = 'pass'

    if (
      probability !== undefined &&
      probability < settings.turnStoppingThreshold &&
      used < settings.turnStoppingMaxSteers
    ) {
      steerCounts.set(key, used + 1)
      if (steerCounts.size > 500) steerCounts.clear()
      action = 'steer'
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: unfinishedNudge(probability) }],
          source: PLUGIN_SOURCE,
        }),
      )
      ctx.logger.warn(
        `[dsh-jev-loop] turn ${String(turn)} looked unfinished (p=${probability.toFixed(2)}); nudged (${String(used + 1)}/${String(settings.turnStoppingMaxSteers)})`,
      )
    }

    audit(settings.auditPath, {
      gate: 'agent/turn-stopping',
      session: agent.session.id,
      turn,
      taskComplete: probability,
      threshold: settings.turnStoppingThreshold,
      action,
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
  })

  // The credential store may be provided after this plugin mounts, so resolve
  // again once it exists — and let a stored key win over a bare env fallback
  // that was the best answer a moment ago.
  const injectable = ctx as unknown as {
    inject(deps: string[], callback: (ctx: Context) => void): unknown
  }
  injectable.inject(['credentials'], () => {
    if (client === undefined || keyStatus.source.startsWith('env:')) {
      client = undefined
      void ensureClient()
    }
  })

  ctx.logger.info(
    `[dsh-jev-loop] mounted (model=${settings.model}, gates=${[...gates.values()]
      .filter((gate) => gate.enabled)
      .map((gate) => gate.name)
      .join(',') || 'none'})`,
  )
}
