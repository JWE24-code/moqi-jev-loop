/**
 * The gate decisions, driven directly — no Harness, no Cordis, no network.
 */
import assert from 'node:assert/strict'

import {
  decidePostExecute,
  decidePreExecute,
  decidePreStep,
  decideTurnStopping,
  hazardsAt,
  noulOf,
} from '../src/gates.ts'
import type { Answer } from '../src/jev.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const noul = (p: number): Answer => ({ type: 'noul', noul: p })
const answers = (pairs: Record<string, number>): Record<string, Answer> =>
  Object.fromEntries(Object.entries(pairs).map(([id, p]) => [id, noul(p)]))

// ----------------------------------------------------------------- pre-step

check('pre-step clarifies at the threshold', decidePreStep(answers({ underspecified: 0.7 }), 0.7).clarify)
check('pre-step passes below it', !decidePreStep(answers({ underspecified: 0.5 }), 0.7).clarify)
check('pre-step passes when unanswered', !decidePreStep({}, 0.7).clarify)
check(
  'pre-step keeps the probability for the audit',
  decidePreStep(answers({ underspecified: 0.5 }), 0.7).probability === 0.5,
)
check(
  'a clarification carries its instruction',
  (decidePreStep(answers({ underspecified: 0.9 }), 0.7).instruction ?? '').includes('clarity check'),
)

// -------------------------------------------------------------- pre-execute

const mixed = decidePreExecute(
  answers({ destructive: 0.9, exfiltration: 0.1, offTask: 0.8 }),
  'log',
  0.7,
)
check('log mode always allows', mixed.action === 'allow')
check('log mode still reports both flags', mixed.flagged.length === 2)
check('ask mode asks when flagged', decidePreExecute(answers({ destructive: 0.9 }), 'ask', 0.7).action === 'ask')
check('deny mode denies when flagged', decidePreExecute(answers({ destructive: 0.9 }), 'deny', 0.7).action === 'deny')
check('enforcement allows a clean call', decidePreExecute(answers({ destructive: 0.1 }), 'deny', 0.7).action === 'allow')
check(
  'the reason names each hazard with its probability',
  (decidePreExecute(answers({ destructive: 0.9 }), 'deny', 0.7).reason ?? '').includes('destructive=0.90'),
)
check(
  'flags keep question order, not probability order',
  hazardsAt(answers({ offTask: 0.9, destructive: 0.9 }), 0.7)
    .map((hazard) => hazard.name)
    .join(',') === 'destructive,offTask',
)

// ------------------------------------------------------------- post-execute

check('log mode accepts', decidePostExecute(answers({ resultMissed: 0.9 }), 'log', 0.7).action === 'accept')
check('block mode blocks at the threshold', decidePostExecute(answers({ resultMissed: 0.7 }), 'block', 0.7).action === 'block')
check('block mode accepts below it', decidePostExecute(answers({ resultMissed: 0.5 }), 'block', 0.7).action === 'accept')
check(
  'a block carries corrective feedback',
  (decidePostExecute(answers({ resultMissed: 0.9 }), 'block', 0.7).feedback ?? '').includes('result check'),
)

// ------------------------------------------------------------- turn-stopping

check('turn-stopping nudges below the threshold', decideTurnStopping(answers({ taskComplete: 0.3 }), 0.5).action === 'nudge')
check('turn-stopping passes at it', decideTurnStopping(answers({ taskComplete: 0.5 }), 0.5).action === 'pass')
check(
  'a nudge carries its text',
  (decideTurnStopping(answers({ taskComplete: 0.3 }), 0.5).text ?? '').includes('completion check'),
)

// ---------------------------------------------------------------- reading

check(
  'noulOf ignores a non-Noul answer',
  noulOf({ a: { type: 'choice', choice: 'x', probabilities: {}, confidence: 1 } }, 'a') === undefined,
)

console.log(`ok - ${String(checks)} gate checks passed`)
