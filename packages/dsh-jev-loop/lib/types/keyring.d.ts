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
import type { Judger } from './jev.ts';
/**
 * The slice of the Harness credential provider this plugin uses.
 *
 * A port: production adapts `ctx.credentials` onto it, tests pass a map.
 */
export interface CredentialStore {
    resolve(ref: string): Promise<{
        value: string;
        source: string;
    } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
}
/** Whether a key is live right now, and where it came from. Never the value. */
export interface KeyStatus {
    set: boolean;
    source: string;
}
/** The outcome of storing or forgetting a key. */
export interface KeyResult {
    ok: boolean;
    error?: string;
}
/** What a {@link Keyring} needs to resolve and build judgers. */
export interface KeyringOptions {
    /** A key fixed in config; beats every stored or ambient source. */
    configKey?: string;
    /** Environment read when nothing else supplies a key. */
    env: Record<string, string | undefined>;
    /** Environment names tried in order. Default the two TypeSafe names. */
    envNames?: readonly string[];
    /** The credential-store reference a stored key lives under. */
    refName: string;
    /** Turn a resolved key into a judger. */
    make: (apiKey: string) => Judger;
    /** The store, when the Harness mounts one; read lazily. */
    store?: () => CredentialStore | undefined;
}
/** The key's source, its live judger, and every transition between them. */
export declare class Keyring {
    private judger;
    private key;
    private readonly options;
    constructor(options: KeyringOptions);
    /** Presence and source of the live key, for a control surface. */
    status(): KeyStatus;
    /** The live judger, or `undefined` while no key is resolved. */
    live(): Judger | undefined;
    /** Resolve and cache a judger; `undefined` means no key anywhere. */
    refresh(): Promise<Judger | undefined>;
    /**
     * Re-resolve because the credential store may now be present.
     *
     * A config key still wins, and a stored key outranks a bare environment
     * fallback that was the best answer before the store mounted; an already
     * stored key is left alone.
     */
    refreshStored(): Promise<Judger | undefined>;
    /** Store a key, probe it, and start using it at once. */
    set(value: string): Promise<KeyResult>;
    /** Forget the stored key and stop judging until another is set. */
    clear(): Promise<KeyResult>;
    /** Resolve the key from config, then the store, then the environment. */
    private resolve;
    /** Install a judger for a resolved key. */
    private adopt;
}
