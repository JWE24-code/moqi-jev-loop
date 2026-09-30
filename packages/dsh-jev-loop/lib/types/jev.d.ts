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
/** A yes/no judgment: the probability that the answer is yes. */
export interface NoulQuestion {
    type: 'noul';
    instructions: string | Record<string, unknown>;
    criteria?: {
        true?: string;
        false?: string;
    };
}
/** A single-choice judgment over a closed option set. */
export interface ChoiceQuestion {
    type: 'choice';
    instructions: string | Record<string, unknown>;
    criteria: Record<string, string | null>;
}
/** A judgment along an ordered rubric. */
export interface ScoreQuestion {
    type: 'score';
    instructions: string | Record<string, unknown>;
    criteria: (string | Record<string, unknown>)[];
}
/** One typed question, keyed by an id this plugin chooses. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
/** The answer to a {@link NoulQuestion}. */
export interface NoulAnswer {
    type: 'noul';
    noul: number;
}
/** The answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}
/** The answer to a {@link ScoreQuestion}. */
export interface ScoreAnswer {
    type: 'score';
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}
/** One typed answer, keyed by the question id it answers. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
/** Token accounting for one evaluation. */
export interface JevUsage {
    input_tokens?: number;
    output_tokens?: number;
}
/** The decoded response body. */
export interface JevResponse {
    model: string;
    answers: Record<string, Answer>;
    usage?: JevUsage;
}
/** A response plus how it was obtained. */
export interface JevResult extends JevResponse {
    cache: 'hit' | 'miss';
    latencyMs: number;
}
/** Whether a client is configured well enough to call. */
export interface JevClientOptions {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    maxStateChars: number;
    cacheEntries: number;
}
/** Cumulative counters, surfaced in the audit line and logs. */
export interface JevClientStats {
    calls: number;
    cacheHits: number;
    inputTokens: number;
    outputTokens: number;
}
/** A cached, capped, retrying caller of the TypeSafe evaluation endpoint. */
export declare class JevClient {
    private readonly options;
    private readonly cache;
    private calls;
    private cacheHits;
    private inputTokens;
    private outputTokens;
    constructor(options: JevClientOptions);
    /** Cumulative counters since the plugin loaded. */
    stats(): JevClientStats;
    /**
     * Evaluate `state` against `questions`.
     *
     * @returns the typed answers, or `undefined` when the service could not be
     *   reached or answered with an error.
     */
    systemOne(state: string, questions: Record<string, Question>, caller?: AbortSignal): Promise<JevResult | undefined>;
    /** Keep the tail, which is the half of a long transcript that matters. */
    private capState;
    /** Store a response, evicting the least-recently-used entry past the cap. */
    private remember;
    /** One request, with the retry loop around the service's overload statuses. */
    private request;
}
