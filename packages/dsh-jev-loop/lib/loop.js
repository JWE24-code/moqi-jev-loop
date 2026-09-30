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
import { GATE_META, POST_EXECUTE_QUESTIONS, PRE_EXECUTE_QUESTIONS, PRE_STEP_QUESTIONS, TURN_STOPPING_QUESTIONS, decidePostExecute, decidePreExecute, decidePreStep, decideTurnStopping, } from "./gates.js";
import { lastUserRequest, renderMessages } from "./render.js";
/** How many turns' worth of per-turn bookkeeping to keep before resetting. */
const BOOKKEEPING_LIMIT = 500;
/** Serialize tool arguments for the judgment without ever throwing. */
function safeArguments(value) {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    }
    catch {
        return '[unserializable]';
    }
}
/** The live judger's counters, or zeroes while none is resolved. */
function noStats() {
    return { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0 };
}
/** A decision mapped back into the outcome shape, with its transport facts. */
function judged(outcome, cache, latencyMs, usage) {
    return { ...outcome, answered: true, cache, latencyMs, usage };
}
/**
 * The four gates over one keyring.
 *
 * Install it once (`apply` does) and call one method per harness event; each
 * returns plain data, so nothing above this file has to know how a judgment
 * was obtained.
 */
export class JevLoop {
    registry = new Map();
    /** Turns whose pre-step judgment has already run. */
    judged = new Set();
    /** Nudges used per turn. */
    steers = new Map();
    options;
    constructor(options) {
        this.options = options;
        const overrides = options.overrides ?? {};
        for (const meta of GATE_META) {
            this.registry.set(meta.name, {
                name: meta.name,
                label: meta.label,
                description: meta.description,
                enabled: overrides[meta.name] ?? options.defaultEnabled(meta.name),
                mode: options.modeFor(meta.name),
            });
        }
    }
    // --------------------------------------------------------- control surface
    /** Every gate and its live state. */
    gates() {
        return [...this.registry.values()].map((gate) => ({ ...gate }));
    }
    /** Flip one gate; `undefined` when the name is unknown. */
    toggle(name) {
        const gate = this.registry.get(name);
        if (gate === undefined)
            return undefined;
        return this.set(name, !gate.enabled);
    }
    /** Set one gate explicitly; `undefined` when the name is unknown. */
    setEnabled(name, enabled) {
        return this.set(name, enabled);
    }
    /** The live judger's counters, or zeroes while no key is resolved. */
    stats() {
        return this.options.keyring.live()?.stats() ?? noStats();
    }
    /** Whether a key is resolved right now. */
    hasApiKey() {
        return this.options.keyring.status().set;
    }
    /** Where the live key came from, never its value. */
    keySource() {
        return this.options.keyring.status().source;
    }
    /** Store a key and start judging with it. */
    setApiKey(value) {
        return this.options.keyring.set(value);
    }
    /** Forget the stored key. */
    clearApiKey() {
        return this.options.keyring.clear();
    }
    // --------------------------------------------------------------- the gates
    /** Judge a request once per turn, before its first step. */
    async preStep(input) {
        if (!this.enabled('preStep'))
            return { action: 'pass', answered: false };
        const key = `${input.sessionId}:${String(input.turn)}`;
        if (this.judged.has(key))
            return { action: 'pass', answered: false };
        const judger = await this.judger();
        if (judger === undefined)
            return { action: 'pass', answered: false };
        const state = this.render(input.messages, 10);
        const result = await judger.systemOne(state, PRE_STEP_QUESTIONS, input.signal);
        // Judge a turn once even when the service is down, so a failure does not
        // cost one request per step.
        this.judged.add(key);
        if (this.judged.size > BOOKKEEPING_LIMIT)
            this.judged.clear();
        if (result === undefined) {
            this.options.audit({ gate: 'agent/pre-step', outcome: 'no-answer', turn: input.turn });
            return { action: 'pass', answered: false };
        }
        const decision = decidePreStep(result.answers, this.options.settings.preStepThreshold);
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
        });
        return judged({
            action: decision.clarify ? 'clarify' : 'pass',
            probability: decision.probability,
            instruction: decision.clarify ? decision.instruction : undefined,
        }, result.cache, result.latencyMs, result.usage);
    }
    /** Judge one tool call before it is dispatched. */
    async preTool(input) {
        if (!this.enabled('preExecute') || this.options.settings.preExecuteSkip.has(input.toolName)) {
            return { action: 'allow', flagged: [], probabilities: {}, answered: false };
        }
        const judger = await this.judger();
        if (judger === undefined) {
            return { action: 'allow', flagged: [], probabilities: {}, answered: false };
        }
        const state = [
            this.request(input.messages),
            `tool: ${input.toolName}`,
            `arguments: ${safeArguments(input.arguments)}`,
        ].join('\n');
        const result = await judger.systemOne(state, PRE_EXECUTE_QUESTIONS, input.signal);
        if (result === undefined) {
            this.options.audit({
                gate: 'tools/pre-execute',
                tool: input.toolName,
                outcome: 'no-answer',
            });
            return { action: 'allow', flagged: [], probabilities: {}, answered: false };
        }
        const decision = decidePreExecute(result.answers, this.options.settings.preExecuteMode, this.options.settings.preExecuteThreshold);
        this.options.audit({
            gate: 'tools/pre-execute',
            tool: input.toolName,
            mode: this.options.settings.preExecuteMode,
            probabilities: decision.probabilities,
            flagged: decision.flagged,
            cache: result.cache,
            latencyMs: result.latencyMs,
            usage: result.usage,
        });
        return judged(decision, result.cache, result.latencyMs, result.usage);
    }
    /** Judge a successful tool result before it is accepted. */
    async postTool(input) {
        if (!this.enabled('postExecute'))
            return { action: 'accept', answered: false };
        const judger = await this.judger();
        if (judger === undefined)
            return { action: 'accept', answered: false };
        const state = [
            this.request(input.messages),
            `tool: ${input.toolName}`,
            `arguments: ${safeArguments(input.arguments)}`,
            `output: ${input.output}`,
        ].join('\n');
        const result = await judger.systemOne(state, POST_EXECUTE_QUESTIONS, input.signal);
        if (result === undefined) {
            this.options.audit({
                gate: 'tools/post-execute',
                tool: input.toolName,
                outcome: 'no-answer',
            });
            return { action: 'accept', answered: false };
        }
        const decision = decidePostExecute(result.answers, this.options.settings.postExecuteMode, this.options.settings.postExecuteThreshold);
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
        });
        return judged(decision, result.cache, result.latencyMs, result.usage);
    }
    /** Judge a turn before it closes, within its per-turn nudge budget. */
    async turnStopping(input) {
        if (!this.enabled('turnStopping'))
            return { action: 'pass', answered: false };
        const judger = await this.judger();
        if (judger === undefined)
            return { action: 'pass', answered: false };
        const state = this.render(input.messages, this.options.settings.turnStoppingMaxMessages);
        const result = await judger.systemOne(state, TURN_STOPPING_QUESTIONS, input.signal);
        if (result === undefined) {
            this.options.audit({
                gate: 'agent/turn-stopping',
                session: input.sessionId,
                turn: input.turn,
                outcome: 'no-answer',
            });
            return { action: 'pass', answered: false };
        }
        const decision = decideTurnStopping(result.answers, this.options.settings.turnStoppingThreshold);
        const key = `${input.sessionId}:${String(input.turn)}`;
        const used = this.steers.get(key) ?? 0;
        const nudges = decision.action === 'nudge' && used < this.options.settings.turnStoppingMaxSteers;
        if (nudges) {
            this.steers.set(key, used + 1);
            if (this.steers.size > BOOKKEEPING_LIMIT)
                this.steers.clear();
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
        });
        return judged(nudges
            ? { action: 'nudge', probability: decision.probability, text: decision.text }
            : { action: 'pass', probability: decision.probability }, result.cache, result.latencyMs, result.usage);
    }
    // ------------------------------------------------------------- internals
    enabled(gate) {
        return this.registry.get(gate)?.enabled === true;
    }
    set(name, enabled) {
        const gate = this.registry.get(name);
        if (gate === undefined)
            return undefined;
        gate.enabled = enabled;
        this.options.persist(this.gates());
        return { ...gate };
    }
    async judger() {
        return this.options.keyring.refresh();
    }
    render(messages, maxMessages) {
        return renderMessages(messages, maxMessages, this.options.settings.maxStateChars);
    }
    request(messages) {
        return lastUserRequest(messages) ?? 'user: (no direct request yet)';
    }
}
