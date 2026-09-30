/**
 * Where the API key comes from, and how one becomes a live judger.
 *
 * The resolution order is fixed here — explicit config, then the credential
 * store, then the environment — and so is the lifecycle: a stored key is
 * probed once before it takes over, and clearing it drops the live judger.
 * The store and the client factory are injected ports, so the whole thing is
 * testable without a Harness or a network.
 * @module
 */
/** A cheap round-trip that proves a key can reach the service. */
const PROBE_QUESTIONS = {
    reachable: {
        type: 'noul',
        instructions: 'Does this state consist of the word "ok"?',
        criteria: { true: 'The state is basically ok', false: 'Anything else' },
    },
};
/** A message from an unknown thrown value. */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** The key's source, its live judger, and every transition between them. */
export class Keyring {
    judger;
    key = { set: false, source: 'none' };
    options;
    constructor(options) {
        this.options = options;
    }
    /** Presence and source of the live key, for a control surface. */
    status() {
        return this.key;
    }
    /** The live judger, or `undefined` while no key is resolved. */
    live() {
        return this.judger;
    }
    /** Resolve and cache a judger; `undefined` means no key anywhere. */
    async refresh() {
        return this.judger ?? this.resolve();
    }
    /**
     * Re-resolve because the credential store may now be present.
     *
     * A config key still wins, and a stored key outranks a bare environment
     * fallback that was the best answer before the store mounted; an already
     * stored key is left alone.
     */
    async refreshStored() {
        if (this.key.source === 'config')
            return this.judger;
        if (this.judger !== undefined && !this.key.source.startsWith('env:'))
            return this.judger;
        this.judger = undefined;
        return this.resolve();
    }
    /** Store a key, probe it, and start using it at once. */
    async set(value) {
        const trimmed = value.trim();
        if (trimmed === '')
            return this.clear();
        const store = this.options.store?.();
        if (store === undefined) {
            return {
                ok: false,
                error: 'the Harness credential store is not mounted; set TYPESAFE_APIKEY instead',
            };
        }
        try {
            await store.set(this.options.refName, trimmed);
        }
        catch (error) {
            return { ok: false, error: describeError(error) };
        }
        const probe = this.options.make(trimmed);
        const answer = await probe.systemOne('ok', PROBE_QUESTIONS);
        this.judger = probe;
        this.key = { set: true, source: 'credential:file' };
        if (answer === undefined) {
            return { ok: false, error: 'saved, but the TypeSafe API did not answer — check the key' };
        }
        return { ok: true };
    }
    /** Forget the stored key and stop judging until another is set. */
    async clear() {
        const store = this.options.store?.();
        if (store !== undefined) {
            try {
                await store.unset(this.options.refName);
            }
            catch {
                // Removing an absent reference is a no-op anyway.
            }
        }
        this.judger = undefined;
        this.key = { set: false, source: 'none' };
        return { ok: true };
    }
    /** Resolve the key from config, then the store, then the environment. */
    async resolve() {
        const fromConfig = this.options.configKey;
        if (fromConfig !== undefined && fromConfig !== '')
            return this.adopt(fromConfig, 'config');
        const store = this.options.store?.();
        if (store !== undefined) {
            try {
                const resolved = await store.resolve(this.options.refName);
                if (resolved !== undefined && resolved.value !== '') {
                    return this.adopt(resolved.value, `credential:${resolved.source}`);
                }
            }
            catch {
                // A failing store must not mask an environment key.
            }
        }
        const names = this.options.envNames ?? ['TYPESAFE_API_KEY', 'TYPESAFE_APIKEY'];
        for (const name of names) {
            const value = this.options.env[name];
            if (value !== undefined && value !== '')
                return this.adopt(value, `env:${name}`);
        }
        this.judger = undefined;
        this.key = { set: false, source: 'none' };
        return undefined;
    }
    /** Install a judger for a resolved key. */
    adopt(apiKey, source) {
        this.judger = this.options.make(apiKey);
        this.key = { set: true, source };
        return this.judger;
    }
}
