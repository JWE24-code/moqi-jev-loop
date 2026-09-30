/**
 * Turn derived session messages into the plain text a System One model reads.
 *
 * Jev is text-only and pays per token, so this is deliberately lossy: content
 * blocks flatten to a readable line, and only the tail of a long transcript is
 * kept — the recent work is what a completion judgment needs.
 * @module
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
/** One list of content blocks as plain lines. */
export declare function renderContent(blocks: readonly ContentBlock[]): string;
/** One derived message as `role: body`. */
export declare function renderMessage(message: Message): string;
/**
 * Render the last `maxMessages` messages, capped to `maxChars`.
 *
 * The cap keeps the tail: an over-long transcript loses its earliest turns,
 * which a judgment about the current turn does not need.
 */
export declare function renderMessages(messages: readonly Message[], maxMessages: number, maxChars: number): string;
/** The most recent direct human prompt, ignoring injected plugin context. */
export declare function lastUserRequest(messages: readonly Message[]): string | undefined;
