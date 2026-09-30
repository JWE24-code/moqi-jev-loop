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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export type { GateName, GateState, PostExecuteMode, PreExecuteMode } from './gates.ts';
export type { JevLoopService } from './loop.ts';
export type { KeyStatus } from './keyring.ts';
/** Stable Cordis plugin name. */
export declare const name = "dsh-jev-loop";
/** No services are required: the gates are event listeners over an injected key. */
export declare const inject: string[];
/** The service key a host looks up to render the control panel. */
export declare const JEV_LOOP_SERVICE = "jevLoop";
/** Plugin config, resolved from the bundle patch or a profile layer. */
export interface Config {
    /** Literal key; prefer `apiKeyEnv` so no secret lives in a config file. */
    apiKey?: string;
    /** Environment variable holding the key. Default `TYPESAFE_API_KEY`. */
    apiKeyEnv?: string;
    /** TypeSafe model alias. Default `jev-latest`. */
    model?: string;
    /** Evaluation endpoint. Default the public System One endpoint. */
    baseUrl?: string;
    /** Per-request timeout in milliseconds. Default 3000. */
    timeoutMs?: number;
    /** Retries on 429/529, network errors, and timeouts. Default 2. */
    maxRetries?: number;
    /** Hard cap on the state characters sent to Jev. Default 24000. */
    maxStateChars?: number;
    /** In-memory cache entries, keyed by the exact request body. Default 500. */
    cacheEntries?: number;
    /** JSONL audit trail of every judgment. Default `$DSH_HOME/jev-loop.jsonl`. */
    auditPath?: string;
    /** Where the runtime gate toggles persist. Default `$DSH_HOME/jev-loop.json`. */
    statePath?: string;
    /** Judge the request before the first step. Default false. */
    preStepEnabled?: boolean;
    /** Clarification probability at or above which a question is requested. Default 0.7. */
    preStepThreshold?: number;
    /** Judge every tool call before dispatch. Default true. */
    preExecuteEnabled?: boolean;
    /** `log` observes only, `ask` requests approval, `deny` refuses. Default `log`. */
    preExecuteMode?: string;
    /** Hazard probability at or above which the call is flagged. Default 0.7. */
    preExecuteThreshold?: number;
    /** Tool names to skip entirely. Default empty. */
    preExecuteSkip?: string[];
    /** Check a successful tool result before it is accepted. Default true. */
    postExecuteEnabled?: boolean;
    /** `log` observes only, `block` turns corrective feedback into an error. Default `log`. */
    postExecuteMode?: string;
    /** Failure probability at or above which a result is blocked. Default 0.7. */
    postExecuteThreshold?: number;
    /** Check the turn before it closes. Default true. */
    turnStoppingEnabled?: boolean;
    /** Completion probability below which the turn is nudged onward. Default 0.5. */
    turnStoppingThreshold?: number;
    /** Most nudges per turn, so a wrong judgment cannot loop forever. Default 2. */
    turnStoppingMaxSteers?: number;
    /** Most transcript messages fed to the completion judgment. Default 14. */
    turnStoppingMaxMessages?: number;
}
export declare const Config: z<Config>;
/** Mount the gates and provide the control service. */
export declare function apply(ctx: Context, config: Config): void;
