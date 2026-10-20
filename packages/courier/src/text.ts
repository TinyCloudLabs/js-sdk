/**
 * Text rules for what a human approves (spec §7), shared byte for byte with the `/courier` view: a field the
 * approval depends on is refused, never repaired or shortened, if any character could hide or reorder what the
 * human reads. The vectors in `test/vectors/request-fields.json` are the contract; copy them.
 */

/** Controls (Cc), format incl. bidi and tag characters (Cf), private use (Co), unassigned (Cn), lone surrogates (Cs), line/paragraph separators. */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
/** Not format characters, but blank or near-blank on screen: Braille blank U+2800, object replacement U+FFFC, musical null notehead U+1D159. */
const INVISIBLE_LOOKALIKES = /[\u2800\uFFFC\u{1D159}]/u;
/** Variation selectors, U+034F, U+115F/1160, U+17B4/17B5, U+180B-180F, U+3164, U+FFA0, tag characters, soft hyphen, ... */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/** Any space other than U+0020 (no-break, em, ideographic, ...): look-alikes for a plain space. */
const ODD_SPACE = /(?! )\p{Zs}/u;
/** More than this many combining marks in a row is overdraw, not text. */
export const MAX_COMBINING_RUN = 3;
const COMBINING_RUN = new RegExp(`\\p{M}{${MAX_COMBINING_RUN + 1},}`, 'u');

export const MAX_SUMMARY = 200;
export const MAX_TARGET = 200;
export const MAX_ACTION = 2000;
export const MAX_REASON = 2000;
export const MAX_RISK = 2000;

/**
 * Why `value` cannot be shown to a human as-is, or undefined if it can. `multiline` additionally allows U+000A (the
 * free-text `action`, `reason` and `risk`); a tab or carriage return is refused everywhere.
 */
export function hiddenTextProblem(value: string, multiline = false): string | undefined {
  const text = multiline ? value.replace(/\n/g, ' ') : value;
  if (FORBIDDEN.test(text)) return 'it contains control, format (bidi, zero-width, tag), private-use, unassigned or separator characters';
  if (INVISIBLE_LOOKALIKES.test(text)) return 'it contains a character that renders blank (U+2800, U+FFFC, U+1D159)';
  if (IGNORABLE.test(text)) return 'it contains invisible (default-ignorable) characters such as variation selectors';
  if (ODD_SPACE.test(text)) return 'it contains a space other than a plain space';
  if (COMBINING_RUN.test(text)) return `it stacks more than ${MAX_COMBINING_RUN} combining marks on one character`;
  if (value !== value.normalize('NFC')) return 'it is not in Unicode normalization form NFC';
  return undefined;
}

/** A single line a human reads: 1..max UTF-16 units, trimmed, nothing hidden. */
export function plainLineProblem(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return 'it is not a string';
  if (value.length === 0) return 'it is empty';
  if (value.length > max) return `it is ${value.length} characters; the limit is ${max}`;
  if (value !== value.trim()) return 'it has leading or trailing whitespace';
  return hiddenTextProblem(value);
}

/** Free text the human reads (`action`, `reason`, `risk`): 1..max, nothing hidden, newlines allowed. */
export function plainTextProblem(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return 'it is not a string';
  if (value.length === 0) return 'it is empty';
  if (value.length > max) return `it is ${value.length} characters; the limit is ${max}`;
  return hiddenTextProblem(value, true);
}

/** `target`: printable ASCII (no look-alike letters), trimmed, one line. */
export function asciiTargetProblem(value: unknown): string | undefined {
  const line = plainLineProblem(value, MAX_TARGET);
  if (line) return line;
  return /^[\x20-\x7e]+$/.test(value as string) ? undefined : 'it is not printable ASCII';
}

/** What each verb's stored target must look like: the view applies exactly these shapes on top of the ASCII rule. */
const TARGET_SHAPES: Record<string, RegExp> = {
  merge: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#[0-9]+|@[A-Za-z0-9_.@/+*-]+)$/,
  publish: /^(npm:|release:|changeset:|script:)\S.*$/,
  deploy: /^(wrangler:|pages:|phala:|script:)\S.*$/,
  other: /^[a-z][a-z0-9-]{0,30}:\S(.*\S)?$/,
  spend: /^spend:\S(.*\S)?$/,
};

export function targetShapeProblem(verb: string, target: string): string | undefined {
  const shape = TARGET_SHAPES[verb];
  return shape && shape.test(target) ? undefined : `it does not have the form a "${verb}" target must have`;
}

/** Every string (keys and values) anywhere in a parsed request, for the hidden-text sweep in `courier approval`. */
export function* allStrings(value: unknown, depth = 0): Generator<string> {
  if (depth > 128) return;
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* allStrings(item, depth + 1);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* allStrings(item, depth + 1);
    }
  }
}
