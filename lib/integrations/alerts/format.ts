/** Alerts format — échappement des valeurs insérées dans les messages d'alerte (HTML léger) */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Escapes a value before inserting it into an alert message. Messages use a light HTML markup
 * (`<b>`, `<i>`) that `htmlToText` strips for the bell and push: Home Assistant names (rooms,
 * files, states) are user-editable, and an unescaped `<` would swallow part of the text.
 *
 * @param value - Raw text coming from Home Assistant.
 * @returns The text with `&`, `<`, `>` and `"` escaped.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"]/g, char => HTML_ESCAPES[char]);
}
