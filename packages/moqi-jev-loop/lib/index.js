/**
 * The `/JevLoop` panel for moqi.
 *
 * A thin adapter: moqi brings the host seam, `dsh-jev-loop` brings the
 * `jevLoop` service, and `panel.ts` turns that service into rows and actions.
 * Both services are injected, so the adapter never applies where either is
 * absent.
 * @module
 */
import { panelActivate, panelRows, } from "./panel.js";
/** Stable Cordis plugin name. */
export const name = 'moqi-jev-loop';
/** The core's control service and moqi's host seam, both required. */
export const inject = ['jevLoop', 'tuiHost'];
/** Register the panel with moqi; the core owns every decision behind it. */
export function apply(ctx) {
    const service = ctx.get('jevLoop');
    const host = ctx.get('tuiHost');
    if (service === undefined || host === undefined)
        return;
    host.registerPanel({
        name: 'JevLoop',
        title: 'Jev Loop',
        description: 'Jev gates and API key (dsh-jev-loop)',
        rows: () => panelRows(service),
        activate: (id) => panelActivate(service, id),
    });
}
