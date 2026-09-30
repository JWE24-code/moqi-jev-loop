/**
 * The JevLoop as one module: gate bookkeeping, modes, budgets, and audit —
 * driven by an in-memory judger through the keyring port.
 */
import assert from 'node:assert/strict'

import type { GateName, GateState } from '../src/gates.ts'
import type { Answer, JevResult, Judger } from '../src/jev.ts'
import { Keyring } from '../src/keyring.ts'
import { JevLoop, type JevLoopSettings } from '../src/loop.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const noul = (p: number): Answer => ({ type: 'noul', noul: p })

interface Harness {
  loop: JevLoop
  audits: Record<string, unknown>[]
  persisted: GateState[][]
  calls: () => number
}

/** One loop over a counting judger; `env: {}` models "no key at all". */
function makeLoop(options: {
  answers?: Record<string, number>
  settings?: Partial<JevLoopSettings>
  env?: Record<string, string>
  defaults?: Partial<Record<GateName, boolean>>
} = {}): Harness {
  const audits: Record<string, unknown>[] = []
  const persisted: GateState[][] = []
  const answered: Record<string, Answer> = {}
  for (const [id, p] of Object.entries(options.answers ?? {})) answered[id] = noul(p)
  let calls = 0
  const judger: Judger = {
    async systemOne(): Promise<JevResult | undefined> {
      calls += 1
      return {
        model: 'test',
        answers: answered,
        usage: { input_tokens: 1, output_tokens: 1 },
        cache: 'miss',
        latencyMs: 1,
      }
    },
    stats: () => ({ calls, cacheHits: 0, inputTokens: 0, outputTokens: 0 }),
  }
  const keyring = new Keyring({
    env: options.env ?? { TYPESAFE_API_KEY: 'key' },
    refName: 'R',
    make: () => judger,
  })
  const settings: JevLoopSettings = {
    maxStateChars: 24000,
    preStepThreshold: 0.7,
    preExecuteMode: 'log',
    preExecuteThreshold: 0.7,
    preExecuteSkip: new Set(),
    postExecuteMode: 'log',
    postExecuteThreshold: 0.7,
    turnStoppingThreshold: 0.5,
    turnStoppingMaxSteers: 2,
    turnStoppingMaxMessages: 14,
    ...options.settings,
  }
  const loop = new JevLoop({
    keyring,
    settings,
    defaultEnabled: (gate) => options.defaults?.[gate] ?? true,
    modeFor: (gate) =>
      gate === 'preExecute'
        ? settings.preExecuteMode
        : gate === 'postExecute'
          ? settings.postExecuteMode
          : gate === 'turnStopping'
            ? 'nudge'
            : 'clarify',
    persist: (gates) => persisted.push([...gates]),
    audit: (entry) => audits.push(entry),
  })
  return { loop, audits, persisted, calls: () => calls }
}

// --------------------------------------------------------------- control surface

{
  const { loop, persisted } = makeLoop({ defaults: { preStep: false, preExecute: true } })
  const gates = loop.gates()
  check('the default gate flags are reported', !gates.find((g) => g.name === 'preStep')?.enabled)
  check('and an enabled one is too', gates.find((g) => g.name === 'preExecute')?.enabled === true)
  const toggled = loop.toggle('preStep')
  check('toggling reports the new state', toggled?.enabled === true)
  check('toggling persists once', persisted.length === 1)
  check('an unknown gate toggles nothing', loop.toggle('nope' as GateName) === undefined)
  check('setEnabled is explicit', loop.setEnabled('preExecute', false)?.enabled === false)
}

// ------------------------------------------------------------------- pre-execute

{
  const { loop, audits, calls } = makeLoop({ answers: { destructive: 0.9, exfiltration: 0.1, offTask: 0.2 } })
  const outcome = await loop.preTool({ messages: [], toolName: 'bash', arguments: { cmd: 'rm -rf /' } })
  check('log mode allows the call', outcome.action === 'allow')
  check('but reports the flagged hazard', outcome.flagged.length === 1 && outcome.flagged[0]?.name === 'destructive')
  check('the audit line carries the probabilities', typeof audits[0]?.['probabilities'] === 'object')
  check('the call was judged', calls() === 1)
}

{
  const { loop } = makeLoop({
    answers: { destructive: 0.9 },
    settings: { preExecuteMode: 'deny' },
  })
  const outcome = await loop.preTool({ messages: [], toolName: 'bash', arguments: {} })
  check('deny mode denies', outcome.action === 'deny')
  check('with a reason naming the hazard', (outcome.reason ?? '').includes('destructive=0.90'))
}

{
  const { loop, calls } = makeLoop({
    answers: { destructive: 0.9 },
    settings: { preExecuteSkip: new Set(['read']) },
  })
  const outcome = await loop.preTool({ messages: [], toolName: 'read', arguments: {} })
  check('a skipped tool is allowed', outcome.action === 'allow')
  check('and never reaches Jev', calls() === 0)
}

// ------------------------------------------------------------------ post-execute

{
  const { loop, audits } = makeLoop({
    answers: { resultMissed: 0.9 },
    settings: { postExecuteMode: 'block' },
  })
  const outcome = await loop.postTool({ messages: [], toolName: 'bash', arguments: {}, output: 'no output' })
  check('block mode blocks', outcome.action === 'block')
  check('with feedback', (outcome.feedback ?? '').includes('result check'))
  check('and the audit records the block', audits[0]?.['action'] === 'block')
}

// ----------------------------------------------------------------- turn-stopping

{
  const { loop, calls } = makeLoop({
    answers: { taskComplete: 0.2 },
    settings: { turnStoppingMaxSteers: 1 },
  })
  const first = await loop.turnStopping({ sessionId: 's', turn: 1, messages: [] })
  const second = await loop.turnStopping({ sessionId: 's', turn: 1, messages: [] })
  check('a low probability nudges', first.action === 'nudge')
  check('the nudge carries text', (first.text ?? '').includes('completion check'))
  check('the budget caps a second nudge', second.action === 'pass')
  check('both calls still reached Jev', calls() === 2)
}

// ---------------------------------------------------------------------- pre-step

{
  const { loop, calls } = makeLoop({ answers: { underspecified: 0.8 } })
  const first = await loop.preStep({ sessionId: 's', turn: 1, messages: [] })
  const second = await loop.preStep({ sessionId: 's', turn: 1, messages: [] })
  check('an underspecified request clarifies', first.action === 'clarify')
  check('the instruction is carried', (first.instruction ?? '').includes('clarity check'))
  check('the same turn is judged once', second.action === 'pass' && calls() === 1)
}

// ------------------------------------------------------------------ fail-open

{
  const { loop, calls } = makeLoop({ env: {}, answers: { destructive: 0.9 } })
  const pre = await loop.preTool({ messages: [], toolName: 'bash', arguments: {} })
  const stop = await loop.turnStopping({ sessionId: 's', turn: 1, messages: [] })
  check('with no key, a tool call is allowed', pre.action === 'allow')
  check('with no key, the turn is not nudged', stop.action === 'pass')
  check('and nothing was called', calls() === 0)
}

{
  const { loop, calls } = makeLoop({ defaults: { preExecute: false }, answers: { destructive: 0.9 } })
  const outcome = await loop.preTool({ messages: [], toolName: 'bash', arguments: {} })
  check('a disabled gate allows without judging', outcome.action === 'allow' && calls() === 0)
}

console.log(`ok - ${String(checks)} loop checks passed`)
