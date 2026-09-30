/**
 * The Jev loop: the four gates as one deep module.
 *
 * It owns everything between a harness event and a decision: looking up the
 * live judger, assembling the state that goes to it, applying the thresholds
 * and modes, the once-per-turn and max-nudges budgets, and the audit line.
 * The Cordis adapter above it only maps the outcomes onto harness decisions,
 * and the tests drive the same methods with an in-memory judger.
 * @module
 */

import type { Message } from '@deepseek-ai/dsh-llm'

import {
  GATE_META,
  POST_EXECUTE_QUESTIONS,
  PRE_EXECUTE_QUESTIONS,
  PRE_STEP_QUESTIONS,
  TURN_STOPPING_QUESTIONS,
  decidePostExecute,
  decidePreExecute,
  decidePreStep,
  decideTurnStopping,
  type Flagged,
  type GateName,
  type GateState,
  type PostExecuteMode,
  type PreExecuteMode,
} from './gates.ts'
import type { JevClientStats, JevUsage, Judger } from './jev.ts'
import type { Keyring } from './keyring.ts'
import { lastUserRequest, renderMessages } from './render.ts'

/** The knobs the loop reads, already defaulted. */
export interface JevLoopSettings {
  maxStateChars: number
  preStepThreshold: number
  preExecuteMode: PreExecuteMode
  preExecuteThreshold: number
  preExecuteSkip: ReadonlySet<string>
  postExecuteMode: PostExecuteMode
  postExecuteThreshold: number
  turnStoppingThreshold: number
  turnStoppingMaxSteers: number
  turnStoppingMaxMessages: number
}

/** A result that went to Jev, and what came back. */
export interface Judged {
  /** False when no judger was live or the service returned nothing. */
  answered: boolean
  cache?: 'hit' | 'miss'
  latencyMs?: number
  usage?: JevUsage
}

/** What the pre-step gate concluded about a request. */
export interface PreStepOutcome extends Judged {
  action: 'pass' | 'clarify'
  probability?: number
  instruction?: string
}

/** What the pre-execute gate concluded about a call. */
export interface PreToolOutcome extends Judged {
  action: 'allow' | 'ask' | 'deny'
  flagged: Flagged[]
  probabilities: Record<string, number>
  reason?: string
}

/** What the post-execute gate concluded about a result. */
export interface PostToolOutcome extends Judged {
  action: 'accept' | 'block'
  probability?: number
  feedback?: string
}

/** What the turn-stopping gate concluded about a turn. */
export interface TurnOutcome extends Judged {
  action: 'pass' | 'nudge'
  probability?: number
  text?: string
}

/** What {@link JevLoop} needs to run. */
export interface JevLoopOptions {
  /** Resolves the key and builds judgers. */
  keyring: Keyring
  settings: JevLoopSettings
  /** A gate's default enabled flag, before persisted overrides. */
  defaultEnabled: (gate: GateName) => boolean
  /** A gate's configured mode label, for the control surface. */
  modeFor: (gate: GateName) => string
  /** Persisted enabled flags, keyed by gate. */
  overrides?: Partial<Record<GateName, boolean>>
  /** Persist the enabled flags after a toggle. */
  persist: (gates: readonly GateState[]) => void
  /** Append one audit line; never throws into the loop. */
  audit: (entry: Record<string, unknown>) => void
}

/**
 * The control surface the loop offers a host.
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

/** How many turns' worth of per-turn bookkeeping to keep before resetting. */
const BOOKKEEPING_LIMIT = 500

/** Serialize tool arguments for the judgment without ever throwing. */
function safeArguments(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return '[unserializable]'
  }
}

/** The live judger's counters, or zeroes while none is resolved. */
function noStats(): JevClientStats {
  return { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0 }
}

/** A decision mapped back into the outcome shape, with its transport facts. */
function judged<T extends { action: string }>(
  outcome: T,
  cache: 'hit' | 'miss',
  latencyMs: number,
  usage: JevUsage | undefined,
): T & Judged {
  return { ...outcome, answered: true, cache, latencyMs, usage }
}

/**
 * The four gates over one keyring.
 *
 * Install it once (`apply` does) and call one method per harness event; each
 * returns plain data, so nothing above this file has to know how a judgment
 * was obtained.
 */
export class JevLoop implements JevLoopService {
  private readonly registry = new Map<GateName, GateState>()
  /** Turns whose pre-step judgment has already run. */
  private readonly judged = new Set<string>()
  /** Nudges used per turn. */
  private readonly steers = new Map<string, number>()
  private readonly options: JevLoopOptions

  constructor(options: JevLoopOptions) {
    this.options = options
    const overrides = options.overrides ?? {}
    for (const meta of GATE_META) {
      this.registry.set(meta.name, {
        name: meta.name,
        label: meta.label,
        description: meta.description,
        enabled: overrides[meta.name] ?? options.defaultEnabled(meta.name),
        mode: options.modeFor(meta.name),
      })
    }
  }

  // --------------------------------------------------------- control surface

  /** Every gate and its live state. */
  gates(): GateState[] {
    return [...this.registry.values()].map((gate) => ({ ...gate }))
  }

  /** Flip one gate; `undefined` when the name is unknown. */
  toggle(name: GateName): GateState | undefined {
    const gate = this.registry.get(name)
    if (gate === undefined) return undefined
    return this.set(name, !gate.enabled)
  }

  /** Set one gate explicitly; `undefined` when the name is unknown. */
  setEnabled(name: GateName, enabled: boolean): GateState | undefined {
    return this.set(name, enabled)
  }

  /** The live judger's counters, or zeroes while no key is resolved. */
  stats(): JevClientStats {
    return this.options.keyring.live()?.stats() ?? noStats()
  }

  /** Whether a key is resolved right now. */
  hasApiKey(): boolean {
    return this.options.keyring.status().set
  }

  /** Where the live key came from, never its value. */
  keySource(): string {
    return this.options.keyring.status().source
  }

  /** Store a key and start judging with it. */
  setApiKey(value: string): Promise<{ ok: boolean; error?: string }> {
    return this.options.keyring.set(value)
  }

  /** Forget the stored key. */
  clearApiKey(): Promise<{ ok: boolean; error?: string }> {
    return this.options.keyring.clear()
  }

  // --------------------------------------------------------------- the gates

  /** Judge a request once per turn, before its first step. */
  async preStep(input: {
    sessionId: string
    turn: number
    messages: readonly Message[]
    signal?: AbortSignal
  }): Promise<PreStepOutcome> {
    if (!this.enabled('preStep')) return { action: 'pass', answered: false }
    const key = `${input.sessionId}:${String(input.turn)}`
    if (this.judged.has(key)) return { action: 'pass', answered: false }

    const judger = await this.judger()
    if (judger === undefined) return { action: 'pass', answered: false }

    const state = this.render(input.messages, 10)
    const result = await judger.systemOne(state, PRE_STEP_QUESTIONS, input.signal)
    // Judge a turn once even when the service is down, so a failure does not
    // cost one request per step.
    this.judged.add(key)
    if (this.judged.size > BOOKKEEPING_LIMIT) this.judged.clear()
    if (result === undefined) {
      this.options.audit({ gate: 'agent/pre-step', outcome: 'no-answer', turn: input.turn })
      return { action: 'pass', answered: false }
    }

    const decision = decidePreStep(result.answers, this.options.settings.preStepThreshold)
    this.options.audit({
      gate: 'agent/pre-step',
      session: input.sessionId,
      turn: input.turn,
      underspecified: decision.probability,
      threshold: this.options.settings.preStepThreshold,
      action: decision.clarify ? 'inject' : 'pass',
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
    return judged(
      {
        action: decision.clarify ? 'clarify' : 'pass',
        probability: decision.probability,
        instruction: decision.clarify ? decision.instruction : undefined,
      },
      result.cache,
      result.latencyMs,
      result.usage,
    ) as PreStepOutcome
  }

  /** Judge one tool call before it is dispatched. */
  async preTool(input: {
    messages: readonly Message[]
    toolName: string
    arguments: unknown
    signal?: AbortSignal
  }): Promise<PreToolOutcome> {
    if (!this.enabled('preExecute') || this.options.settings.preExecuteSkip.has(input.toolName)) {
      return { action: 'allow', flagged: [], probabilities: {}, answered: false }
    }
    const judger = await this.judger()
    if (judger === undefined) {
      return { action: 'allow', flagged: [], probabilities: {}, answered: false }
    }

    const state = [
      this.request(input.messages),
      `tool: ${input.toolName}`,
      `arguments: ${safeArguments(input.arguments)}`,
    ].join('\n')
    const result = await judger.systemOne(state, PRE_EXECUTE_QUESTIONS, input.signal)
    if (result === undefined) {
      this.options.audit({
        gate: 'tools/pre-execute',
        tool: input.toolName,
        outcome: 'no-answer',
      })
      return { action: 'allow', flagged: [], probabilities: {}, answered: false }
    }

    const decision = decidePreExecute(
      result.answers,
      this.options.settings.preExecuteMode,
      this.options.settings.preExecuteThreshold,
    )
    this.options.audit({
      gate: 'tools/pre-execute',
      tool: input.toolName,
      mode: this.options.settings.preExecuteMode,
      probabilities: decision.probabilities,
      flagged: decision.flagged,
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
    return judged(decision, result.cache, result.latencyMs, result.usage) as PreToolOutcome
  }

  /** Judge a successful tool result before it is accepted. */
  async postTool(input: {
    messages: readonly Message[]
    toolName: string
    arguments: unknown
    output: string
    signal?: AbortSignal
  }): Promise<PostToolOutcome> {
    if (!this.enabled('postExecute')) return { action: 'accept', answered: false }
    const judger = await this.judger()
    if (judger === undefined) return { action: 'accept', answered: false }

    const state = [
      this.request(input.messages),
      `tool: ${input.toolName}`,
      `arguments: ${safeArguments(input.arguments)}`,
      `output: ${input.output}`,
    ].join('\n')
    const result = await judger.systemOne(state, POST_EXECUTE_QUESTIONS, input.signal)
    if (result === undefined) {
      this.options.audit({
        gate: 'tools/post-execute',
        tool: input.toolName,
        outcome: 'no-answer',
      })
      return { action: 'accept', answered: false }
    }

    const decision = decidePostExecute(
      result.answers,
      this.options.settings.postExecuteMode,
      this.options.settings.postExecuteThreshold,
    )
    this.options.audit({
      gate: 'tools/post-execute',
      tool: input.toolName,
      mode: this.options.settings.postExecuteMode,
      resultMissed: decision.probability,
      threshold: this.options.settings.postExecuteThreshold,
      action: decision.action === 'block' ? 'block' : 'accept',
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
    return judged(decision, result.cache, result.latencyMs, result.usage) as PostToolOutcome
  }

  /** Judge a turn before it closes, within its per-turn nudge budget. */
  async turnStopping(input: {
    sessionId: string
    turn: number
    messages: readonly Message[]
    signal?: AbortSignal
  }): Promise<TurnOutcome> {
    if (!this.enabled('turnStopping')) return { action: 'pass', answered: false }
    const judger = await this.judger()
    if (judger === undefined) return { action: 'pass', answered: false }

    const state = this.render(input.messages, this.options.settings.turnStoppingMaxMessages)
    const result = await judger.systemOne(state, TURN_STOPPING_QUESTIONS, input.signal)
    if (result === undefined) {
      this.options.audit({
        gate: 'agent/turn-stopping',
        session: input.sessionId,
        turn: input.turn,
        outcome: 'no-answer',
      })
      return { action: 'pass', answered: false }
    }

    const decision = decideTurnStopping(
      result.answers,
      this.options.settings.turnStoppingThreshold,
    )
    const key = `${input.sessionId}:${String(input.turn)}`
    const used = this.steers.get(key) ?? 0
    const nudges = decision.action === 'nudge' && used < this.options.settings.turnStoppingMaxSteers
    if (nudges) {
      this.steers.set(key, used + 1)
      if (this.steers.size > BOOKKEEPING_LIMIT) this.steers.clear()
    }

    this.options.audit({
      gate: 'agent/turn-stopping',
      session: input.sessionId,
      turn: input.turn,
      taskComplete: decision.probability,
      threshold: this.options.settings.turnStoppingThreshold,
      action: nudges ? 'steer' : 'pass',
      cache: result.cache,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })
    return judged(
      nudges
        ? { action: 'nudge', probability: decision.probability, text: decision.text }
        : { action: 'pass', probability: decision.probability },
      result.cache,
      result.latencyMs,
      result.usage,
    ) as TurnOutcome
  }

  // ------------------------------------------------------------- internals

  private enabled(gate: GateName): boolean {
    return this.registry.get(gate)?.enabled === true
  }

  private set(name: GateName, enabled: boolean): GateState | undefined {
    const gate = this.registry.get(name)
    if (gate === undefined) return undefined
    gate.enabled = enabled
    this.options.persist(this.gates())
    return { ...gate }
  }

  private async judger(): Promise<Judger | undefined> {
    return this.options.keyring.refresh()
  }

  private render(messages: readonly Message[], maxMessages: number): string {
    return renderMessages(messages, maxMessages, this.options.settings.maxStateChars)
  }

  private request(messages: readonly Message[]): string {
    return lastUserRequest(messages) ?? 'user: (no direct request yet)'
  }
}
