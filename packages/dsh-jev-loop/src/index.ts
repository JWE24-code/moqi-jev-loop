/**
 * Jev in the agent loop: the Cordis adapter.
 *
 * This file only knows how the Harness names things. The judgments, the key
 * lifecycle, and the gate bookkeeping live in `gates.ts`, `keyring.ts`, and
 * `loop.ts`; the handlers below translate one harness event into one
 * {@link JevLoop} call and one harness decision back.
 *
 * Four gates, all automatic — the model never asks for them:
 *
 * - `agent/pre-step` judges the request before the first step and can inject a
 *   clarifying-question instruction.
 * - `tools/pre-execute` judges a tool call before it runs and can allow, ask,
 *   or deny.
 * - `tools/post-execute` judges a successful result and can block it with
 *   corrective feedback.
 * - `agent/turn-stopping` judges the turn before it closes and can steer a
 *   nudge so the loop keeps working.
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

import { JevClient } from './jev.ts'
import { Keyring, type CredentialStore } from './keyring.ts'
import { JevLoop, type JevLoopSettings } from './loop.ts'
import { renderContent } from './render.ts'

export type { GateName, GateState, PostExecuteMode, PreExecuteMode } from './gates.ts'
export type { JevLoopService } from './loop.ts'
export type { KeyStatus } from './keyring.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-jev-loop'

/** No services are required: the gates are event listeners over an injected key. */
export const inject: string[] = []

/** The service key a host looks up to render the control panel. */
export const JEV_LOOP_SERVICE = 'jevLoop'

/** The credential-store reference a panel-set key is stored under. */
const KEY_REF_NAME = 'TYPESAFE_API_KEY'

/** The source stamped on every context this plugin injects or steers. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: name } as const

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

/** The config default for one gate, before a persisted override. */
function defaultEnabled(config: Config, gate: keyof typeof GATE_DEFAULTS): boolean {
  return config[GATE_DEFAULTS[gate]] ?? DEFAULTS[gate]
}

/** The config field and fallback for each gate's enabled flag. */
const GATE_DEFAULTS = {
  preStep: 'preStepEnabled',
  preExecute: 'preExecuteEnabled',
  postExecute: 'postExecuteEnabled',
  turnStopping: 'turnStoppingEnabled',
} as const

/** Whether a gate runs when the profile does not say. */
const DEFAULTS = {
  preStep: false,
  preExecute: true,
  postExecute: true,
  turnStopping: true,
} as const

/** The mode label a gate shows a control surface. */
function modeFor(gate: keyof typeof GATE_DEFAULTS, settings: JevLoopSettings): string {
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

/** Everything the adapter resolves out of {@link Config} before wiring. */
interface Settings {
  /** A key fixed in config, if any; the keyring prefers it. */
  configKey: string | undefined
  auditPath: string
  statePath: string
  /** How a resolved key becomes a client. */
  client: {
    model: string
    baseUrl: string
    timeoutMs: number
    maxRetries: number
    maxStateChars: number
    cacheEntries: number
  }
  /** The knobs the loop reads. */
  loop: JevLoopSettings
}

/** Apply every config default once, in one place. */
function resolveSettings(config: Config): Settings {
  const dshHome =
    process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
      ? process.env['DSH_HOME']
      : join(homedir(), '.dsh')
  const maxStateChars = config.maxStateChars ?? 24000
  return {
    configKey: config.apiKey,
    auditPath: config.auditPath ?? join(dshHome, 'jev-loop.jsonl'),
    statePath: config.statePath ?? join(dshHome, 'jev-loop.json'),
    client: {
      model: config.model ?? 'jev-latest',
      baseUrl: config.baseUrl ?? 'https://api.typesafe.ai/v1/systemone',
      timeoutMs: config.timeoutMs ?? 3000,
      maxRetries: config.maxRetries ?? 2,
      maxStateChars,
      cacheEntries: config.cacheEntries ?? 500,
    },
    loop: {
      maxStateChars,
      preStepThreshold: config.preStepThreshold ?? 0.7,
      preExecuteMode:
        config.preExecuteMode === 'ask' || config.preExecuteMode === 'deny'
          ? config.preExecuteMode
          : 'log',
      preExecuteThreshold: config.preExecuteThreshold ?? 0.7,
      preExecuteSkip: new Set(config.preExecuteSkip ?? []),
      postExecuteMode: config.postExecuteMode === 'block' ? 'block' : 'log',
      postExecuteThreshold: config.postExecuteThreshold ?? 0.7,
      turnStoppingThreshold: config.turnStoppingThreshold ?? 0.5,
      turnStoppingMaxSteers: config.turnStoppingMaxSteers ?? 2,
      turnStoppingMaxMessages: config.turnStoppingMaxMessages ?? 14,
    },
  }
}

/** Load the persisted gate overrides; a missing or broken file is empty. */
function loadOverrides(path: string): Partial<Record<string, boolean>> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      gates?: Record<string, boolean>
    }
    return parsed.gates ?? {}
  } catch {
    return {}
  }
}

/** Persist the gate overrides; a failed write is not worth breaking over. */
function saveOverrides(path: string, gates: readonly { name: string; enabled: boolean }[]): void {
  try {
    const out: Record<string, boolean> = {}
    for (const gate of gates) out[gate.name] = gate.enabled
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

/** Adapt the Harness credential service onto the keyring's port, if mounted. */
function credentialStore(ctx: Context): CredentialStore | undefined {
  const credentials = ctx.get('credentials') as
    | {
        resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
        set(ref: unknown, value: string): Promise<void>
        unset(ref: unknown): Promise<void>
      }
    | undefined
  if (credentials === undefined) return undefined
  return {
    resolve: (ref) => credentials.resolve(credentialRef(ref)),
    set: (ref, value) => credentials.set(credentialRef(ref), value),
    unset: (ref) => credentials.unset(credentialRef(ref)),
  }
}

/** A plugin-sourced user message: the only channel the loop can speak on. */
function pluginMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
}

/** Mount the gates and provide the control service. */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(config)

  const keyring = new Keyring({
    configKey: settings.configKey,
    env: process.env,
    refName: KEY_REF_NAME,
    make: (apiKey) => new JevClient({ apiKey, ...settings.client }),
    store: () => credentialStore(ctx),
  })

  const loop = new JevLoop({
    keyring,
    settings: settings.loop,
    defaultEnabled: (gate) => defaultEnabled(config, gate as keyof typeof GATE_DEFAULTS),
    modeFor: (gate) => modeFor(gate as keyof typeof GATE_DEFAULTS, settings.loop),
    overrides: loadOverrides(settings.statePath),
    persist: (gates) => saveOverrides(settings.statePath, gates),
    audit: (entry) => audit(settings.auditPath, entry),
  })

  // The service is always provided, so the panel opens and the toggles persist
  // even when no key is configured and no judgment can run.
  ctx.provide(JEV_LOOP_SERVICE, loop)

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const outcome = await loop.preStep({
      sessionId: agent.session.id,
      turn,
      messages: agent.session.deriveMessages(),
      signal,
    })
    if (outcome.action !== 'clarify' || outcome.instruction === undefined) return next()
    return { kind: 'enter', messages: [...messages, pluginMessage(outcome.instruction)] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const outcome = await loop.preTool({
      messages: exec.agent?.session.deriveMessages() ?? [],
      toolName: exec.name,
      arguments: exec.arguments,
      signal: exec.signal,
    })
    if (outcome.action === 'deny') {
      const reason = outcome.reason ?? 'Jev denied this call'
      ctx.logger.warn(`[dsh-jev-loop] ${reason}: ${exec.name}`)
      return { kind: 'deny', reason }
    }
    if (outcome.action === 'ask') {
      if (outcome.reason !== undefined) ctx.logger.warn(`[dsh-jev-loop] ${outcome.reason}: ${exec.name}`)
      return { kind: 'ask', reason: outcome.reason }
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // A result the harness already marked as an error needs no second opinion.
    if (result.isError === true) return next()
    const outcome = await loop.postTool({
      messages: exec.agent?.session.deriveMessages() ?? [],
      toolName: exec.name,
      arguments: exec.arguments,
      output: renderContent(result.content),
      signal: exec.signal,
    })
    if (outcome.action !== 'block' || outcome.feedback === undefined) return next()
    ctx.logger.warn(
      `[dsh-jev-loop] result for ${exec.name} looked wrong (p=${(outcome.probability ?? 0).toFixed(2)}); blocked`,
    )
    return { kind: 'block', feedback: [{ type: 'text', text: outcome.feedback }] }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const outcome = await loop.turnStopping({
      sessionId: agent.session.id,
      turn,
      messages: agent.session.deriveMessages(),
      signal,
    })
    if (outcome.action !== 'nudge' || outcome.text === undefined) return
    ctx.logger.warn(
      `[dsh-jev-loop] turn ${String(turn)} looked unfinished (p=${(outcome.probability ?? 0).toFixed(2)}); nudged`,
    )
    agent.steer(pluginMessage(outcome.text))
  })

  // Resolve the key at mount so the panel shows its real state and an env or
  // stored key is live from the first gate.
  void keyring.refresh().then((judger) => {
    if (judger === undefined) {
      ctx.logger.warn(
        '[dsh-jev-loop] no TypeSafe API key yet; set one from moqi /JevLoop or TYPESAFE_APIKEY',
      )
    }
  })

  // The credential store may be provided after this plugin mounts, so resolve
  // again once it exists — a stored key then outranks a bare env fallback.
  const injectable = ctx as unknown as {
    inject(deps: string[], callback: (ctx: Context) => void): unknown
  }
  injectable.inject(['credentials'], () => {
    void keyring.refreshStored()
  })

  ctx.logger.info(
    `[dsh-jev-loop] mounted (model=${settings.client.model}, gates=${loop
      .gates()
      .filter((gate) => gate.enabled)
      .map((gate) => gate.name)
      .join(',') || 'none'})`,
  )
}
