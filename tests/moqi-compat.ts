/**
 * Compile-time check that the panel's structural copy of moqi's `tuiHost` seam
 * still matches the real one.
 *
 * `panel.ts` mirrors moqi's panel types instead of importing them, so the
 * plugin has no build dependency on moqi. This file is never run: `npm run
 * typecheck:moqi` compiles it against whichever `moqi-tui` is installed, and a
 * drift in either direction fails the build.
 */

import type {
  TuiHost,
  TuiPanel,
  TuiPanelResult as MoqiPanelResult,
  TuiPanelRow as MoqiPanelRow,
  TuiPanelSecret as MoqiPanelSecret,
} from 'moqi-tui/tui-host'

import type {
  TuiHostLike,
  TuiPanelResult,
  TuiPanelRow,
  TuiPanelSecret,
} from '../src/panel.ts'

/** Compiles only when `A` and `B` are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
function same<A, B>(proof: Same<A, B>): void {
  void proof
}

same<TuiPanelRow, MoqiPanelRow>(true)
same<TuiPanelSecret, MoqiPanelSecret>(true)
same<TuiPanelResult, MoqiPanelResult>(true)

/** The panel `apply` hands to `registerPanel` is one moqi accepts. */
type RegisteredPanel = Parameters<TuiHostLike['registerPanel']>[0]
same<RegisteredPanel, TuiPanel>(true)

/** moqi's real host satisfies what `apply` asks of `ctx.get('tuiHost')`. */
const asLike = (host: TuiHost): TuiHostLike => host
void asLike
