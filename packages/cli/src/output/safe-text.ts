/**
 * Text that another party wrote (app ids, registry names, knowledge files) is
 * printed to a terminal only through these helpers: control characters, ANSI
 * escape introducers and bidirectional overrides are replaced by a visible
 * `\u{..}` escape, so they cannot recolor, rewrite or reorder what the user
 * reads. JSON output keeps the exact text and never goes through here.
 */

/** C0 (without tab and newline), DEL, C1, bidi controls and line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const UNSAFE_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** The same, plus tab and newline: a single-line value cannot start a new line. */
// eslint-disable-next-line no-control-regex
const UNSAFE_INLINE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

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
