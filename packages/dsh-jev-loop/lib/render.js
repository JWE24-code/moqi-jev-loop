/**
 * Turn derived session messages into the plain text a System One model reads.
 *
 * Jev is text-only and pays per token, so this is deliberately lossy: content
 * blocks flatten to a readable line, and only the tail of a long transcript is
 * kept — the recent work is what a completion judgment needs.
 * @module
 */
/** One content block as a line of prose. */
function renderBlock(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'reasoning':
            return `[reasoning] ${block.text}`;
        case 'tool-call':
            return `[tool call ${block.name} ${block.arguments}]`;
        case 'tool-result': {
            const inner = block.content.map(renderBlock).join(' ');
            return `[tool result${block.isError === true ? ' error' : ''}] ${inner}`;
        }
        case 'image':
            return '[image]';
        case 'file':
            return '[file]';
        default:
            return `[${block.type ?? 'unknown'}]`;
    }
}
/** One list of content blocks as plain lines. */
export function renderContent(blocks) {
    return blocks.map(renderBlock).join('\n');
}
/** One derived message as `role: body`. */
export function renderMessage(message) {
    return `${message.role}: ${renderContent(message.content)}`;
}
/**
 * Render the last `maxMessages` messages, capped to `maxChars`.
 *
 * The cap keeps the tail: an over-long transcript loses its earliest turns,
 * which a judgment about the current turn does not need.
 */
export function renderMessages(messages, maxMessages, maxChars) {
    const tail = maxMessages > 0 ? messages.slice(-maxMessages) : messages;
    const text = tail.map(renderMessage).join('\n---\n');
    if (text.length <= maxChars)
        return text;
    return `…[earlier context truncated]\n${text.slice(text.length - maxChars)}`;
}
/** The most recent direct human prompt, ignoring injected plugin context. */
export function lastUserRequest(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user' && message.source.kind === 'user') {
            return renderMessage(message);
        }
    }
    return undefined;
}
