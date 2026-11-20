/** Telegram format — échappement des valeurs insérées dans les messages HTML */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Escapes a value before inserting it into a Telegram message sent with `parse_mode: HTML`.
 * Home Assistant names (rooms, files, states) are user-editable: unescaped, they could
 * inject links or make Telegram reject the whole message, silently dropping the alert.
 *
 * @param value - Raw text coming from Home Assistant or from a chat message.
 * @returns The text with `&`, `<`, `>` and `"` escaped.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"]/g, char => HTML_ESCAPES[char]);
}
