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
import { createHash } from 'node:crypto';
function sleep(ms) {
    return new Promise((done) => setTimeout(done, ms));
}
/** Backoff before a retry: 250ms, 500ms, 1000ms, … capped at 2s. */
function backoff(attempt) {
    return Math.min(250 * 2 ** attempt, 2000);
}
/** A cached, capped, retrying caller of the TypeSafe evaluation endpoint. */
export class JevClient {
    cache = new Map();
    options;
    calls = 0;
    cacheHits = 0;
    inputTokens = 0;
    outputTokens = 0;
    constructor(options) {
        this.options = options;
    }
    /** Cumulative counters since the plugin loaded. */
    stats() {
        return {
            calls: this.calls,
            cacheHits: this.cacheHits,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
        };
    }
    /**
     * Evaluate `state` against `questions`.
     *
     * @returns the typed answers, or `undefined` when the service could not be
     *   reached or answered with an error.
     */
    async systemOne(state, questions, caller) {
        const body = JSON.stringify({
            state: this.capState(state),
            model: this.options.model,
            questions,
        });
        const key = createHash('sha256').update(body).digest('hex');
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            this.cacheHits += 1;
            // Refresh recency so the eviction below drops the coldest entry.
            this.cache.delete(key);
            this.cache.set(key, cached);
            return { ...cached, cache: 'hit', latencyMs: 0 };
        }
        const started = Date.now();
        const response = await this.request(body, caller);
        if (response === undefined)
            return undefined;
        this.remember(key, response);
        this.calls += 1;
        this.inputTokens += response.usage?.input_tokens ?? 0;
        this.outputTokens += response.usage?.output_tokens ?? 0;
        return { ...response, cache: 'miss', latencyMs: Date.now() - started };
    }
    /** Keep the tail, which is the half of a long transcript that matters. */
    capState(state) {
        const max = this.options.maxStateChars;
        if (state.length <= max)
            return state;
        return `…[earlier context truncated]\n${state.slice(state.length - max)}`;
    }
    /** Store a response, evicting the least-recently-used entry past the cap. */
    remember(key, response) {
        this.cache.set(key, response);
        while (this.cache.size > this.options.cacheEntries) {
            const oldest = this.cache.keys().next();
            if (oldest.done === true)
                break;
            this.cache.delete(oldest.value);
        }
    }
    /** One request, with the retry loop around the service's overload statuses. */
    async request(body, caller) {
        for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            caller?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
            try {
                const response = await fetch(this.options.baseUrl, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${this.options.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body,
                    signal: controller.signal,
                });
                if (response.status === 429 || response.status === 529) {
                    if (attempt < this.options.maxRetries) {
                        await sleep(backoff(attempt));
                        continue;
                    }
                    return undefined;
                }
                if (!response.ok)
                    return undefined;
                const parsed = (await response.json());
                if (parsed === null || typeof parsed !== 'object' || parsed.answers === undefined) {
                    return undefined;
                }
                return parsed;
            }
            catch {
                // Caller cancellation is final; a timeout or a socket error retries.
                if (caller?.aborted === true)
                    return undefined;
                if (attempt < this.options.maxRetries) {
                    await sleep(backoff(attempt));
                    continue;
                }
                return undefined;
            }
            finally {
                clearTimeout(timer);
                caller?.removeEventListener('abort', onAbort);
            }
        }
        return undefined;
    }
}
