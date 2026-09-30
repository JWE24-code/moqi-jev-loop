/**
 * The four gate judgments, as pure functions.
 *
 * Everything here is a decision about answers already in hand: no I/O, no
 * Cordis, no timers. The Cordis adapter calls these and turns the results into
 * harness decisions; the tests call exactly the same functions without a
 * harness. Keeping the copy and the question sets here too means a change to
 * "what Jev is asked" and "what we do about the answer" lives in one file.
 * @module
 */
import type { Answer, Question } from './jev.ts';
/** The gates this plugin can run. */
export type GateName = 'preStep' | 'preExecute' | 'postExecute' | 'turnStopping';
/** The enforcement mode of the pre-execute gate. */
export type PreExecuteMode = 'log' | 'ask' | 'deny';
/** The enforcement mode of the post-execute gate. */
export type PostExecuteMode = 'log' | 'block';
/** One gate as a control surface sees it. */
export interface GateState {
    name: GateName;
    label: string;
    description: string;
    enabled: boolean;
    mode: string;
}
/** Declarative order and copy for the four gates. */
export declare const GATE_META: readonly Omit<GateState, 'enabled' | 'mode'>[];
/** One pre-execute question per hazard, asked together in a single call. */
export declare const PRE_EXECUTE_QUESTIONS: Record<string, Question>;
/** The result-audit question, asked after a call that reported success. */
export declare const POST_EXECUTE_QUESTIONS: Record<string, Question>;
/** The first-step clarity question. */
export declare const PRE_STEP_QUESTIONS: Record<string, Question>;
/** The completion question the loop asks before it stops. */
export declare const TURN_STOPPING_QUESTIONS: Record<string, Question>;
/** One question's yes-probability, when it answered as a Noul. */
export declare function noulOf(answers: Record<string, Answer>, id: string): number | undefined;
/** Every Noul answer as a plain map, for a decision or an audit line. */
export declare function probabilities(answers: Record<string, Answer>): Record<string, number>;
/** A hazard the pre-execute gate found at or above its threshold. */
export interface Flagged {
    name: string;
    p: number;
}
/** Hazards at or above the threshold, in question order. */
export declare function hazardsAt(answers: Record<string, Answer>, threshold: number): Flagged[];
/** What the pre-step gate concluded about a request. */
export interface PreStepDecision {
    clarify: boolean;
    probability?: number;
    instruction?: string;
}
/** What the pre-execute gate concluded about a call. */
export interface PreExecuteDecision {
    action: 'allow' | 'ask' | 'deny';
    flagged: Flagged[];
    probabilities: Record<string, number>;
    reason?: string;
}
/** What the post-execute gate concluded about a result. */
export interface PostExecuteDecision {
    action: 'accept' | 'block';
    probability?: number;
    feedback?: string;
}
/** What the turn-stopping gate concluded about a turn. */
export interface TurnStoppingDecision {
    action: 'pass' | 'nudge';
    probability?: number;
    text?: string;
}
/** The context instruction injected when a request looks underspecified. */
export declare function clarifyInstruction(probability: number): string;
/** The corrective nudge steered when a turn looks unfinished. */
export declare function unfinishedNudge(probability: number): string;
/** The feedback that turns a silent failure into a retry. */
export declare function resultFeedback(probability: number): string;
/** Whether the pre-step gate wants a clarifying question, and what to inject. */
export declare function decidePreStep(answers: Record<string, Answer>, threshold: number): PreStepDecision;
/** The pre-execute decision for a call: allow, ask, or deny. */
export declare function decidePreExecute(answers: Record<string, Answer>, mode: PreExecuteMode, threshold: number): PreExecuteDecision;
/** The post-execute decision for a successful result: accept or block. */
export declare function decidePostExecute(answers: Record<string, Answer>, mode: PostExecuteMode, threshold: number): PostExecuteDecision;
/** The turn-stopping decision, before the per-turn nudge budget is applied. */
export declare function decideTurnStopping(answers: Record<string, Answer>, threshold: number): TurnStoppingDecision;
