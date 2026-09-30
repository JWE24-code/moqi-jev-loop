/**
 * The `/JevLoop` control panel for moqi.
 *
 * A thin adapter over `dsh-jev-loop`: it renders the core's gates and API key
 * through moqi's `tuiHost` panel seam and judges nothing itself. It lives in
 * its own package so the core can be released to the plain Harness with no UI
 * dependency at all.
 *
 * Both services are injected, so the adapter simply never applies where the
 * core is absent or moqi is not the host.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'moqi-jev-loop'

/** The core's control service and moqi's host seam, both required. */
export const inject: string[] = ['jevLoop', 'tuiHost']

/** One gate as `dsh-jev-loop` reports it. Structural: no build dependency. */
interface GateState {
  name: string
  label: string
  description: string
  enabled: boolean
  mode: string
}

/** The `jevLoop` service `dsh-jev-loop` provides. */
interface JevLoopService {
  gates(): GateState[]
  toggle(name: string): GateState | undefined
  hasApiKey(): boolean
  keySource(): string
  setApiKey(value: string): Promise<{ ok: boolean; error?: string }>
  clearApiKey(): Promise<{ ok: boolean; error?: string }>
}

/** One row moqi's picker draws. */
interface TuiPanelRow {
  id: string
  title: string
  subtitle: string
  active?: boolean
}

/** A masked prompt moqi raises for a panel action. */
interface TuiPanelSecret {
  kind: 'secret'
  message: string
  placeholder?: string
  submit: (value: string) => void | Promise<void>
}

/** What activating a row produced. */
type TuiPanelResult = void | TuiPanelSecret

/** The `tuiHost` service moqi provides. */
interface TuiHostLike {
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

/** Register the panel with moqi; the core owns every decision behind it. */
export function apply(ctx: Context): void {
  const service = ctx.get('jevLoop') as JevLoopService | undefined
  const host = ctx.get('tuiHost') as TuiHostLike | undefined
  if (service === undefined || host === undefined) return

  host.registerPanel({
    name: 'JevLoop',
    title: 'Jev Loop',
    description: 'Jev gates and API key (dsh-jev-loop)',
    rows: (): TuiPanelRow[] => {
      const key: TuiPanelRow = {
        id: KEY_ROW,
        title: 'API key',
        subtitle: service.hasApiKey()
          ? `set · ${service.keySource()} · enter to replace`
          : 'not set · enter to paste the TypeSafe key',
        active: service.hasApiKey(),
      }
      const clear: TuiPanelRow[] = service.hasApiKey()
        ? [
            {
              id: CLEAR_ROW,
              title: 'Clear API key',
              subtitle: 'remove the stored key',
              active: false,
            },
          ]
        : []
      const gates: TuiPanelRow[] = service.gates().map((gate) => ({
        id: gate.name,
        title: gate.label,
        subtitle: `${gate.enabled ? 'on' : 'off'} · ${gate.mode} · ${gate.description}`,
        active: gate.enabled,
      }))
      return [key, ...clear, ...gates]
    },
    activate: async (id): Promise<TuiPanelResult> => {
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
    },
  })
}
