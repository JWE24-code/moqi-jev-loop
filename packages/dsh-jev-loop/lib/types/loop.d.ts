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
import type { Message } from '@deepseek-ai/dsh-llm';
import { type Flagged, type GateName, type GateState, type PostExecuteMode, type PreExecuteMode } from './gates.ts';
import type { JevClientStats, JevUsage } from './jev.ts';
import type { Keyring } from './keyring.ts';
/** The knobs the loop reads, already defaulted. */
export interface JevLoopSettings {
    maxStateChars: number;
    preStepThreshold: number;
    preExecuteMode: PreExecuteMode;
    preExecuteThreshold: number;
    preExecuteSkip: ReadonlySet<string>;
    postExecuteMode: PostExecuteMode;
    postExecuteThreshold: number;
    turnStoppingThreshold: number;
    turnStoppingMaxSteers: number;
    turnStoppingMaxMessages: number;
}
/** A result that went to Jev, and what came back. */
export interface Judged {
    /** False when no judger was live or the service returned nothing. */
    answered: boolean;
    cache?: 'hit' | 'miss';
    latencyMs?: number;
    usage?: JevUsage;
}
/** What the pre-step gate concluded about a request. */
export interface PreStepOutcome extends Judged {
    action: 'pass' | 'clarify';
    probability?: number;
    instruction?: string;
}
/** What the pre-execute gate concluded about a call. */
export interface PreToolOutcome extends Judged {
    action: 'allow' | 'ask' | 'deny';
    flagged: Flagged[];
    probabilities: Record<string, number>;
    reason?: string;
}
/** What the post-execute gate concluded about a result. */
export interface PostToolOutcome extends Judged {
    action: 'accept' | 'block';
    probability?: number;
    feedback?: string;
}
/** What the turn-stopping gate concluded about a turn. */
export interface TurnOutcome extends Judged {
    action: 'pass' | 'nudge';
    probability?: number;
    text?: string;
}
/** What {@link JevLoop} needs to run. */
export interface JevLoopOptions {
    /** Resolves the key and builds judgers. */
    keyring: Keyring;
    settings: JevLoopSettings;
    /** A gate's default enabled flag, before persisted overrides. */
    defaultEnabled: (gate: GateName) => boolean;
    /** A gate's configured mode label, for the control surface. */
    modeFor: (gate: GateName) => string;
    /** Persisted enabled flags, keyed by gate. */
    overrides?: Partial<Record<GateName, boolean>>;
    /** Persist the enabled flags after a toggle. */
    persist: (gates: readonly GateState[]) => void;
    /** Append one audit line; never throws into the loop. */
    audit: (entry: Record<string, unknown>) => void;
}
/**
 * The control surface the loop offers a host.
 *
 * `moqi-jev-loop` consumes it to render `/JevLoop`; nothing here depends on
 * that host, so the core package mounts headless and unchanged.
 */
export interface JevLoopService {
    gates(): GateState[];
    toggle(name: GateName): GateState | undefined;
    setEnabled(name: GateName, enabled: boolean): GateState | undefined;
    stats(): JevClientStats;
    /** Whether a key is resolvable right now (config, credential store, or env). */
    hasApiKey(): boolean;
    /** Where the live key came from, for a control surface — never the value. */
    keySource(): string;
    /** Store a key in the Harness credential store and start using it at once. */
    setApiKey(value: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Forget the stored key and stop judging until another is set. */
    clearApiKey(): Promise<{
        ok: boolean;
        error?: string;
    }>;
}
/**
 * The four gates over one keyring.
 *
 * Install it once (`apply` does) and call one method per harness event; each
 * returns plain data, so nothing above this file has to know how a judgment
 * was obtained.
 */
export declare class JevLoop implements JevLoopService {
    private readonly registry;
    /** Turns whose pre-step judgment has already run. */
    private readonly judged;
    /** Nudges used per turn. */
    private readonly steers;
    private readonly options;
    constructor(options: JevLoopOptions);
    /** Every gate and its live state. */
    gates(): GateState[];
    /** Flip one gate; `undefined` when the name is unknown. */
    toggle(name: GateName): GateState | undefined;
    /** Set one gate explicitly; `undefined` when the name is unknown. */
    setEnabled(name: GateName, enabled: boolean): GateState | undefined;
    /** The live judger's counters, or zeroes while no key is resolved. */
    stats(): JevClientStats;
    /** Whether a key is resolved right now. */
    hasApiKey(): boolean;
    /** Where the live key came from, never its value. */
    keySource(): string;
    /** Store a key and start judging with it. */
    setApiKey(value: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Forget the stored key. */
    clearApiKey(): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Judge a request once per turn, before its first step. */
    preStep(input: {
        sessionId: string;
        turn: number;
        messages: readonly Message[];
        signal?: AbortSignal;
    }): Promise<PreStepOutcome>;
    /** Judge one tool call before it is dispatched. */
    preTool(input: {
        messages: readonly Message[];
        toolName: string;
        arguments: unknown;
        signal?: AbortSignal;
    }): Promise<PreToolOutcome>;
    /** Judge a successful tool result before it is accepted. */
    postTool(input: {
        messages: readonly Message[];
        toolName: string;
        arguments: unknown;
        output: string;
        signal?: AbortSignal;
    }): Promise<PostToolOutcome>;
    /** Judge a turn before it closes, within its per-turn nudge budget. */
    turnStopping(input: {
        sessionId: string;
        turn: number;
        messages: readonly Message[];
        signal?: AbortSignal;
    }): Promise<TurnOutcome>;
    private enabled;
    private set;
    private judger;
    private render;
    private request;
}
