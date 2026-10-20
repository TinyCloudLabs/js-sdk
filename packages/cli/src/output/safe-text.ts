/**
 * Text that another party wrote (app ids, registry names, knowledge files) is
 * printed to a terminal only through these helpers: control characters, ANSI
 * escape introducers and bidirectional overrides are replaced by a visible
 * `\u{..}` escape, so they cannot recolor, rewrite or reorder what the user
 * reads. JSON output keeps the exact text and never goes through here.
 */

/** C0 (without tab and newline), DEL, C1, zero-width and bidi controls (U+200B-200F, U+202A-202E, U+2066-2069), BOM and line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const UNSAFE_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** The same, plus tab and newline: a single-line value cannot start a new line. */
// eslint-disable-next-line no-control-regex
const UNSAFE_INLINE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function escape(match: string): string {
  return `\\u{${match.codePointAt(0)!.toString(16)}}`;
}

/** Multi-line text (file content): newlines and tabs stay, everything unsafe is escaped. */
export function safeBlock(text: string): string {
  return text.replace(UNSAFE_BLOCK, escape);
}

/** A single-line value (app id, name, path): newlines and tabs are escaped too. */
export function safeInline(text: string): string {
  return text.replace(UNSAFE_INLINE, escape);
}

/** Most characters of one echoed request field in an error message. */
export const ECHO_FIELD_MAX = 80;
/** Most items of an echoed list in an error message. */
export const ECHO_LIST_MAX = 5;

/** A single-line value escaped, then cut to `max` characters (code points) with an ellipsis, so an error stays short. */
export function safeClipped(text: string, max = ECHO_FIELD_MAX): string {
  const escaped = Array.from(safeInline(text));
  return escaped.length <= max ? escaped.join("") : `${escaped.slice(0, max).join("")}…`;
}

/** At most `ECHO_LIST_MAX` items, each escaped and clipped and quoted, then "and N more". */
export function safeClippedList(items: readonly string[]): string {
  const shown = items.slice(0, ECHO_LIST_MAX).map((item) => `"${safeClipped(item)}"`).join(", ");
  return items.length > ECHO_LIST_MAX ? `${shown} … and ${items.length - ECHO_LIST_MAX} more` : shown;
}

/**
 * Characters JSON.stringify leaves as they are but a terminal acts on or hides: DEL, C1 controls (0x80-0x9f,
 * including CSI 0x9b), zero-width and bidi controls, line/paragraph separators and the BOM.
 */
// eslint-disable-next-line no-control-regex
const JSON_UNSAFE = /[\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * `JSON.stringify` whose output is safe to print on a terminal: every character above is written as a `\uXXXX`
 * escape. The text parses to exactly the same value (JSON.stringify already escapes C0 controls and `"`/`\`).
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space);
  return text === undefined ? text : text.replace(JSON_UNSAFE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
