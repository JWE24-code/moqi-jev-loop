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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "moqi-jev-loop";
/** The core's control service and moqi's host seam, both required. */
export declare const inject: string[];
/** Register the panel with moqi; the core owns every decision behind it. */
export declare function apply(ctx: Context): void;
