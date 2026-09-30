/**
 * The `/JevLoop` panel for moqi.
 *
 * A thin adapter: moqi brings the host seam, `dsh-jev-loop` brings the
 * `jevLoop` service, and `panel.ts` turns that service into rows and actions.
 * Both services are injected, so the adapter never applies where either is
 * absent.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
export type { GateState, JevLoopService, TuiPanelResult, TuiPanelRow, TuiPanelSecret, } from './panel.ts';
/** Stable Cordis plugin name. */
export declare const name = "moqi-jev-loop";
/** The core's control service and moqi's host seam, both required. */
export declare const inject: string[];
/** Register the panel with moqi; the core owns every decision behind it. */
export declare function apply(ctx: Context): void;
