/**
 * The `/JevLoop` panel, as plain data over the core's control service.
 *
 * No Cordis, no moqi types: {@link panelRows} builds what the host draws and
 * {@link panelActivate} says what a row does, so a test drives both with a
 * fake service. The host seam lives in `index.ts`.
 * @module
 */
/** The API-key row ids, distinct from any gate name. */
const KEY_ROW = 'key';
const CLEAR_ROW = 'key-clear';
/** The rows to draw right now: the key, then the gates. */
export function panelRows(service) {
    const key = {
        id: KEY_ROW,
        title: 'API key',
        subtitle: service.hasApiKey()
            ? `set · ${service.keySource()} · enter to replace`
            : 'not set · enter to paste the TypeSafe key',
        active: service.hasApiKey(),
    };
    const clear = service.hasApiKey()
        ? [{ id: CLEAR_ROW, title: 'Clear API key', subtitle: 'remove the stored key', active: false }]
        : [];
    const gates = service.gates().map((gate) => ({
        id: gate.name,
        title: gate.label,
        subtitle: `${gate.enabled ? 'on' : 'off'} · ${gate.mode} · ${gate.description}`,
        active: gate.enabled,
    }));
    return [key, ...clear, ...gates];
}
/** What the row chosen with enter does. */
export async function panelActivate(service, id) {
    if (id === KEY_ROW) {
        return {
            kind: 'secret',
            message: 'Paste the TypeSafe API key — stored in the Harness credential store',
            placeholder: 'TYPESAFE_APIKEY',
            submit: async (value) => {
                const result = await service.setApiKey(value);
                if (!result.ok)
                    throw new Error(result.error ?? 'could not save the key');
            },
        };
    }
    if (id === CLEAR_ROW) {
        await service.clearApiKey();
        return undefined;
    }
    service.toggle(id);
    return undefined;
}
