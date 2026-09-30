/**
 * The panel's rows and actions, over a fake `jevLoop` service — no moqi.
 */
import assert from 'node:assert/strict'

import { panelActivate, panelRows, type GateState, type JevLoopService } from '../src/panel.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

interface Fake {
  service: JevLoopService
  toggled: string[]
  saved: string[]
  clears: () => number
  setKey: (set: boolean) => void
  failSet: (fail: boolean) => void
}

/** A service whose gate list and key state the test can drive. */
function fake(): Fake {
  const toggled: string[] = []
  const saved: string[] = []
  let key = false
  let source = 'none'
  let clears = 0
  let fail = false
  const gates: GateState[] = [
    { name: 'preStep', label: 'Pre-step', description: 'ask before guessing', enabled: false, mode: 'clarify' },
    { name: 'preExecute', label: 'Pre-execute', description: 'gate each call', enabled: true, mode: 'log' },
  ]
  const service: JevLoopService = {
    gates: () => gates,
    toggle: (name) => {
      toggled.push(name)
      const gate = gates.find((entry) => entry.name === name)
      if (gate === undefined) return undefined
      gate.enabled = !gate.enabled
      return gate
    },
    hasApiKey: () => key,
    keySource: () => source,
    setApiKey: async (value) => {
      saved.push(value)
      if (fail) return { ok: false, error: 'rejected' }
      key = true
      source = 'credential:file'
      return { ok: true }
    },
    clearApiKey: async () => {
      clears += 1
      key = false
      source = 'none'
      return { ok: true }
    },
  }
  return {
    service,
    toggled,
    saved,
    clears: () => clears,
    setKey: (value) => {
      key = value
      source = value ? 'credential:file' : 'none'
    },
    failSet: (value) => {
      fail = value
    },
  }
}

// ------------------------------------------------------------------- no key

{
  const { service } = fake()
  const rows = panelRows(service)
  check('the key row leads', rows[0]?.id === 'key')
  check('it reads as unset', rows[0]?.subtitle.startsWith('not set') === true)
  check('with no clear row', !rows.some((row) => row.id === 'key-clear'))
  check('then one row per gate', rows.length === 3)
  check('a gate row shows its state', rows[1]?.subtitle.startsWith('off · clarify') === true)
  check('and its active marker', rows[2]?.active === true)
}

// ---------------------------------------------------------------------- keyed

{
  const { service, setKey } = fake()
  setKey(true)
  const rows = panelRows(service)
  check('a live key says where it is from', rows[0]?.subtitle.includes('credential:file') === true)
  check('and offers a clear row', rows.some((row) => row.id === 'key-clear'))
}

// ------------------------------------------------------------------- actions

{
  const harness = fake()
  const result = await panelActivate(harness.service, 'key')
  check('the key row raises a masked prompt', result !== undefined && result.kind === 'secret')
  if (result !== undefined && result.kind === 'secret') {
    check('the prompt is the key instruction', result.message.includes('TypeSafe API key'))
    await result.submit('  pasted  ')
    check('submit passes the value through', harness.saved[0] === '  pasted  ')
  }
}

{
  const harness = fake()
  harness.failSet(true)
  const result = await panelActivate(harness.service, 'key')
  if (result !== undefined && result.kind === 'secret') {
    let threw = false
    try {
      await result.submit('bad')
    } catch (error) {
      threw = true
      check('a rejected key throws the service error', (error as Error).message === 'rejected')
    }
    check('the rejection surfaced', threw)
  } else {
    check('the key row raises a masked prompt', false)
  }
}

{
  const harness = fake()
  await panelActivate(harness.service, 'preStep')
  check('a gate row toggles that gate', harness.toggled[0] === 'preStep')
  await panelActivate(harness.service, 'key-clear')
  check('the clear row clears the key', harness.clears() === 1)
}

console.log(`ok - ${String(checks)} panel checks passed`)
