/**
 * The key lifecycle: resolution order, stored keys, probing, and clearing.
 */
import assert from 'node:assert/strict'

import type { Answer, JevResult, Judger } from '../src/jev.ts'
import { Keyring, type CredentialStore } from '../src/keyring.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

/** A judger that answers every question `1`, or nothing when told to fail. */
function judger(reachable = true): Judger {
  return {
    async systemOne(_state, questions): Promise<JevResult | undefined> {
      if (!reachable) return undefined
      const answers: Record<string, Answer> = {}
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 1 }
      return {
        model: 'test',
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
        cache: 'miss',
        latencyMs: 1,
      }
    },
    stats: () => ({ calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0 }),
  }
}

/** An in-memory credential store, plus its backing map for assertions. */
function store(initial: Record<string, string> = {}): CredentialStore & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    async resolve(ref) {
      const value = data[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async set(ref, value) {
      data[ref] = value
    },
    async unset(ref) {
      delete data[ref]
    },
  }
}

// ----------------------------------------------------------- resolution order

let made: string[] = []
let keyring = new Keyring({
  env: { TYPESAFE_APIKEY: 'env-key' },
  refName: 'R',
  make: (apiKey) => {
    made.push(apiKey)
    return judger()
  },
})
await keyring.refresh()
check('an environment key resolves', keyring.status().set && keyring.status().source === 'env:TYPESAFE_APIKEY')
check('the factory saw the trimmed key', made.at(-1) === 'env-key')

keyring = new Keyring({
  configKey: 'cfg',
  env: { TYPESAFE_API_KEY: 'env' },
  refName: 'R',
  make: () => judger(),
})
await keyring.refresh()
check('a config key wins over everything', keyring.status().source === 'config')

keyring = new Keyring({
  env: { TYPESAFE_API_KEY: 'env' },
  refName: 'R',
  store: () => store({ R: 'stored' }),
  make: () => judger(),
})
await keyring.refresh()
check('a stored key wins over an environment key', keyring.status().source === 'credential:file')

// ----------------------------------------- a store that arrives after the env

let lateStore: CredentialStore | undefined
keyring = new Keyring({
  env: { TYPESAFE_API_KEY: 'env' },
  refName: 'R',
  store: () => lateStore,
  make: () => judger(),
})
await keyring.refresh()
check('the env resolves first', keyring.status().source === 'env:TYPESAFE_API_KEY')
lateStore = store({ R: 'stored' })
await keyring.refreshStored()
check('refreshStored lets the store take over', keyring.status().source === 'credential:file')

// ------------------------------------------------------------------- set/clear

made = []
const backing = store()
keyring = new Keyring({
  env: {},
  refName: 'R',
  store: () => backing,
  make: (apiKey) => {
    made.push(apiKey)
    return judger()
  },
})
const saved = await keyring.set('  fresh  ')
check('set reports success', saved.ok === true)
check('set trims the value', made.at(-1) === 'fresh')
check('set stores under the ref', backing.data['R'] === 'fresh')
check('set adopts the new key', keyring.status().source === 'credential:file')
check('set  is live without a refresh', keyring.live() !== undefined)

const failing = store()
keyring = new Keyring({ env: {}, refName: 'R', store: () => failing, make: () => judger(false) })
const unreachable = await keyring.set('nope')
check('a failing probe still saves', failing.data['R'] === 'nope')
check('but reports that the service did not answer', !unreachable.ok && (unreachable.error ?? '').includes('did not answer'))

await keyring.clear()
check('clear unsets the store', failing.data['R'] === undefined)
check('clear drops the live key', !keyring.status().set && keyring.status().source === 'none')

const noStore = await new Keyring({ env: {}, refName: 'R', make: () => judger() }).set('x')
check('set without a store is refused with advice', !noStore.ok && (noStore.error ?? '').includes('TYPESAFE_APIKEY'))

console.log(`ok - ${String(checks)} keyring checks passed`)
