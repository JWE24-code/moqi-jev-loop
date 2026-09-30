/**
 * A small TypeSafe System One client.
 *
 * The harness deliberately keeps this dependency-free: one POST to
 * `/v1/systemone`, exponential backoff on 429/529, a hard cap on the state
 * that reaches the model, and an in-memory cache keyed by the exact request
 * body so an unchanged judgment is free. Every failure returns `undefined`
 * rather than throwing — a judgment service that is down must not take the
 * agent loop with it.
 * @module
 */

import { createHash } from 'node:crypto'

/** A yes/no judgment: the probability that the answer is yes. */
export interface NoulQuestion {
  type: 'noul'
  instructions: string | Record<string, unknown>
  criteria?: { true?: string; false?: string }
}

/** A single-choice judgment over a closed option set. */
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string | Record<string, unknown>
  criteria: Record<string, string | null>
}

/** A judgment along an ordered rubric. */
export interface ScoreQuestion {
  type: 'score'
  instructions: string | Record<string, unknown>
  criteria: (string | Record<string, unknown>)[]
}

/** One typed question, keyed by an id this plugin chooses. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** The answer to a {@link NoulQuestion}. */
export interface NoulAnswer {
  type: 'noul'
  noul: number
}

/** The answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

/** The answer to a {@link ScoreQuestion}. */
export interface ScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

/** One typed answer, keyed by the question id it answers. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** Token accounting for one evaluation. */
export interface JevUsage {
  input_tokens?: number
  output_tokens?: number
}

/** The decoded response body. */
export interface JevResponse {
  model: string
  answers: Record<string, Answer>
  usage?: JevUsage
}

/** A response plus how it was obtained. */
export interface JevResult extends JevResponse {
  cache: 'hit' | 'miss'
  latencyMs: number
}

/** Whether a client is configured well enough to call. */
export interface JevClientOptions {
  apiKey: string
  model: string
  baseUrl: string
  timeoutMs: number
  maxRetries: number
  maxStateChars: number
  cacheEntries: number
}

/** Cumulative counters, surfaced in the audit line and logs. */
export interface JevClientStats {
  calls: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** Backoff before a retry: 250ms, 500ms, 1000ms, … capped at 2s. */
function backoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2000)
}

/**
 * The judging surface the loop depends on.
 *
 * A port, so tests supply an in-memory judger and production supplies
 * {@link JevClient}; everything above it is transport-agnostic.
 */
export interface Judger {
  systemOne(
    state: string,
    questions: Record<string, Question>,
    caller?: AbortSignal,
  ): Promise<JevResult | undefined>
  stats(): JevClientStats
}

/** A cached, capped, retrying caller of the TypeSafe evaluation endpoint. */
export class JevClient implements Judger {
  private readonly cache = new Map<string, JevResponse>()
  private readonly options: JevClientOptions
  private calls = 0
  private cacheHits = 0
  private inputTokens = 0
  private outputTokens = 0

  constructor(options: JevClientOptions) {
    this.options = options
  }

  /** Cumulative counters since the plugin loaded. */
  stats(): JevClientStats {
    return {
      calls: this.calls,
      cacheHits: this.cacheHits,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
  }

  /**
   * Evaluate `state` against `questions`.
   *
   * @returns the typed answers, or `undefined` when the service could not be
   *   reached or answered with an error.
   */
  async systemOne(
    state: string,
    questions: Record<string, Question>,
    caller?: AbortSignal,
  ): Promise<JevResult | undefined> {
    const body = JSON.stringify({
      state: this.capState(state),
      model: this.options.model,
      questions,
    })
    const key = createHash('sha256').update(body).digest('hex')

    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cacheHits += 1
      // Refresh recency so the eviction below drops the coldest entry.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return { ...cached, cache: 'hit', latencyMs: 0 }
    }

    const started = Date.now()
    const response = await this.request(body, caller)
    if (response === undefined) return undefined

    this.remember(key, response)
    this.calls += 1
    this.inputTokens += response.usage?.input_tokens ?? 0
    this.outputTokens += response.usage?.output_tokens ?? 0
    return { ...response, cache: 'miss', latencyMs: Date.now() - started }
  }

  /** Keep the tail, which is the half of a long transcript that matters. */
  private capState(state: string): string {
    const max = this.options.maxStateChars
    if (state.length <= max) return state
    return `…[earlier context truncated]\n${state.slice(state.length - max)}`
  }

  /** Store a response, evicting the least-recently-used entry past the cap. */
  private remember(key: string, response: JevResponse): void {
    this.cache.set(key, response)
    while (this.cache.size > this.options.cacheEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }

  /** One request, with the retry loop around the service's overload statuses. */
  private async request(body: string, caller?: AbortSignal): Promise<JevResponse | undefined> {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      caller?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
      try {
        const response = await fetch(this.options.baseUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        })
        if (response.status === 429 || response.status === 529) {
          if (attempt < this.options.maxRetries) {
            await sleep(backoff(attempt))
            continue
          }
          return undefined
        }
        if (!response.ok) return undefined
        const parsed = (await response.json()) as JevResponse
        if (parsed === null || typeof parsed !== 'object' || parsed.answers === undefined) {
          return undefined
        }
        return parsed
      } catch {
        // Caller cancellation is final; a timeout or a socket error retries.
        if (caller?.aborted === true) return undefined
        if (attempt < this.options.maxRetries) {
          await sleep(backoff(attempt))
          continue
        }
        return undefined
      } finally {
        clearTimeout(timer)
        caller?.removeEventListener('abort', onAbort)
      }
    }
    return undefined
  }
}
