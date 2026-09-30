/**
 * The `/JevLoop` panel, as plain data over the core's control service.
 *
 * No Cordis, no moqi types: {@link panelRows} builds what the host draws and
 * {@link panelActivate} says what a row does, so a test drives both with a
 * fake service. The host seam lives in `index.ts`.
 * @module
 */

/** One gate as `dsh-jev-loop` reports it. Structural: no build dependency. */
export interface GateState {
  name: string
  label: string
  description: string
  enabled: boolean
  mode: string
}

/** The `jevLoop` service `dsh-jev-loop` provides. */
export interface JevLoopService {
  gates(): GateState[]
  toggle(name: string): GateState | undefined
  hasApiKey(): boolean
  keySource(): string
  setApiKey(value: string): Promise<{ ok: boolean; error?: string }>
  clearApiKey(): Promise<{ ok: boolean; error?: string }>
}

/** One row the host's picker draws. */
export interface TuiPanelRow {
  id: string
  title: string
  subtitle: string
  active?: boolean
}

/** A masked prompt the host raises on the panel's behalf. */
export interface TuiPanelSecret {
  kind: 'secret'
  message: string
  placeholder?: string
  submit: (value: string) => void | Promise<void>
}

/** What activating a row produced. */
export type TuiPanelResult = void | TuiPanelSecret

/** The host service, when moqi is mounted. */
export interface TuiHostLike {
  registerPanel(panel: {
    name: string
    title?: string
    description: string
    rows(): TuiPanelRow[]
    activate(id: string): TuiPanelResult | Promise<TuiPanelResult>
  }): (() => void) | undefined
}

/** The API-key row ids, distinct from any gate name. */
const KEY_ROW = 'key'
const CLEAR_ROW = 'key-clear'

/** The rows to draw right now: the key, then the gates. */
export function panelRows(service: JevLoopService): TuiPanelRow[] {
  const key: TuiPanelRow = {
    id: KEY_ROW,
    title: 'API key',
    subtitle: service.hasApiKey()
      ? `set · ${service.keySource()} · enter to replace`
      : 'not set · enter to paste the TypeSafe key',
    active: service.hasApiKey(),
  }
  const clear: TuiPanelRow[] = service.hasApiKey()
    ? [{ id: CLEAR_ROW, title: 'Clear API key', subtitle: 'remove the stored key', active: false }]
    : []
  const gates: TuiPanelRow[] = service.gates().map((gate) => ({
    id: gate.name,
    title: gate.label,
    subtitle: `${gate.enabled ? 'on' : 'off'} · ${gate.mode} · ${gate.description}`,
    active: gate.enabled,
  }))
  return [key, ...clear, ...gates]
}

/** What the row chosen with enter does. */
export async function panelActivate(
  service: JevLoopService,
  id: string,
): Promise<TuiPanelResult> {
  if (id === KEY_ROW) {
    return {
      kind: 'secret',
      message: 'Paste the TypeSafe API key — stored in the Harness credential store',
      placeholder: 'TYPESAFE_APIKEY',
      submit: async (value: string) => {
        const result = await service.setApiKey(value)
        if (!result.ok) throw new Error(result.error ?? 'could not save the key')
      },
    }
  }
  if (id === CLEAR_ROW) {
    await service.clearApiKey()
    return undefined
  }
  service.toggle(id)
  return undefined
}
