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
/** Declarative order and copy for the four gates. */
export const GATE_META = [
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
];
/** One pre-execute question per hazard, asked together in a single call. */
export const PRE_EXECUTE_QUESTIONS = {
    destructive: {
        type: 'noul',
        instructions: 'Does this tool call destroy, overwrite, or irreversibly modify data beyond what the user request needs?',
        criteria: {
            true: 'It destroys or irreversibly changes something the request did not ask for',
            false: 'It is read-only, additive, or clearly required by the request',
        },
    },
    exfiltration: {
        type: 'noul',
        instructions: 'Does this tool call send credentials, secrets, or private user data to an external destination?',
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
};
/** The result-audit question, asked after a call that reported success. */
export const POST_EXECUTE_QUESTIONS = {
    resultMissed: {
        type: 'noul',
        instructions: 'Did this tool call fail to achieve what was intended, even though it reported success? Answer yes for empty or unchanged output, a wrong target, a silent no-op, or a result that contradicts the intent.',
        criteria: {
            true: 'The intended effect did not happen or is contradicted by the result',
            false: 'The result is consistent with the intended effect',
        },
    },
};
/** The first-step clarity question. */
export const PRE_STEP_QUESTIONS = {
    underspecified: {
        type: 'noul',
        instructions: 'Does this request lack a detail that materially changes the work, such that acting without asking would likely be wrong?',
        criteria: {
            true: 'A missing detail changes the shape of the work; a focused question is warranted',
            false: 'The request is actionable; reasonable assumptions are safe',
        },
    },
};
/** The completion question the loop asks before it stops. */
export const TURN_STOPPING_QUESTIONS = {
    taskComplete: {
        type: 'noul',
        instructions: "Has the agent fully completed the user's most recent request? Answer yes only if every explicit part of the request is done and, where it matters, verified; answer no if anything asked for is missing, unverified, or failed.",
        criteria: {
            true: 'Every part of the request is done and verified',
            false: 'Some part is missing, unverified, or failed',
        },
    },
};
/** One question's yes-probability, when it answered as a Noul. */
export function noulOf(answers, id) {
    const answer = answers[id];
    return answer?.type === 'noul' ? answer.noul : undefined;
}
/** Every Noul answer as a plain map, for a decision or an audit line. */
export function probabilities(answers) {
    const out = {};
    for (const [id, answer] of Object.entries(answers)) {
        if (answer.type === 'noul')
            out[id] = answer.noul;
    }
    return out;
}
/** Hazards at or above the threshold, in question order. */
export function hazardsAt(answers, threshold) {
    const flagged = [];
    for (const id of Object.keys(PRE_EXECUTE_QUESTIONS)) {
        const p = noulOf(answers, id);
        if (p !== undefined && p >= threshold)
            flagged.push({ name: id, p });
    }
    return flagged;
}
/** The context instruction injected when a request looks underspecified. */
export function clarifyInstruction(probability) {
    return [
        `A clarity check (Jev p=${probability.toFixed(2)}) judged this request underspecified.`,
        'Ask the user one focused question about the single most important missing detail, then stop and wait.',
        'Do not guess at the missing detail.',
    ].join(' ');
}
/** The corrective nudge steered when a turn looks unfinished. */
export function unfinishedNudge(probability) {
    return [
        `Before closing this turn: a completion check (Jev p=${probability.toFixed(2)}) judged the user's request not yet fully done.`,
        'Re-read the original request and the work above, then either finish the remaining part or state plainly what is still missing and why.',
        'Do not claim completion you have not verified.',
    ].join(' ');
}
/** The feedback that turns a silent failure into a retry. */
export function resultFeedback(probability) {
    return [
        `A result check (Jev p=${probability.toFixed(2)}) judged this tool call did not achieve what was intended, despite reporting success.`,
        'Inspect the actual output, retry with a corrected call, or explain plainly what failed.',
        'Do not treat this result as success.',
    ].join(' ');
}
/** Whether the pre-step gate wants a clarifying question, and what to inject. */
export function decidePreStep(answers, threshold) {
    const probability = noulOf(answers, 'underspecified');
    if (probability === undefined)
        return { clarify: false };
    return {
        clarify: probability >= threshold,
        probability,
        instruction: clarifyInstruction(probability),
    };
}
/** The pre-execute decision for a call: allow, ask, or deny. */
export function decidePreExecute(answers, mode, threshold) {
    const flagged = hazardsAt(answers, threshold);
    const probabilitiesById = probabilities(answers);
    if (mode === 'log' || flagged.length === 0) {
        return { action: 'allow', flagged, probabilities: probabilitiesById };
    }
    const reason = `Jev flagged this call (${flagged
        .map((hazard) => `${hazard.name}=${hazard.p.toFixed(2)}`)
        .join(', ')})`;
    return {
        action: mode === 'deny' ? 'deny' : 'ask',
        flagged,
        probabilities: probabilitiesById,
        reason,
    };
}
/** The post-execute decision for a successful result: accept or block. */
export function decidePostExecute(answers, mode, threshold) {
    const probability = noulOf(answers, 'resultMissed');
    if (mode !== 'block' || probability === undefined || probability < threshold) {
        return { action: 'accept', probability };
    }
    return { action: 'block', probability, feedback: resultFeedback(probability) };
}
/** The turn-stopping decision, before the per-turn nudge budget is applied. */
export function decideTurnStopping(answers, threshold) {
    const probability = noulOf(answers, 'taskComplete');
    if (probability === undefined || probability >= threshold) {
        return { action: 'pass', probability };
    }
    return { action: 'nudge', probability, text: unfinishedNudge(probability) };
}
