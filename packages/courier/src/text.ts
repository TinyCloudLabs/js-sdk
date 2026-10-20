/** Frozen Unicode text contract for request writes, approval reads and the Courier view. */
import { TEXT_ALLOWED_RANGES } from './text-ranges.js';

export type TextField = 'summary' | 'multiline' | 'target';
export type TextReason = 'not-string' | 'empty' | 'too-long' | 'edge-whitespace' | 'not-nfc' | 'disallowed-code-point';
export type TextVerdict = { allowed: true; reason: null } | { allowed: false; reason: TextReason };
export const MAX_SUMMARY = 200;
export const MAX_TARGET = 200;
export const MAX_ACTION = 2000;
export const MAX_REASON = 2000;
export const MAX_RISK = 2000;
const SUMMARY_PUNCTUATION = ".,:;-_/#()?!'";

/** Character eligibility only; the full-string verdict additionally checks NFC, length and trimming. */
export function textCodePointAllowed(cp: number, field: TextField): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp === 10) return field === 'multiline';
  if (cp >= 0x20 && cp <= 0x7e) {
    return field !== 'summary' || cp === 0x20 ||
      (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) ||
      SUMMARY_PUNCTUATION.includes(String.fromCodePoint(cp));
  }
  if (field === 'target') return false;
  let low = 0, high = TEXT_ALLOWED_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [start, end] = TEXT_ALLOWED_RANGES[mid]!;
    if (cp < start) high = mid - 1;
    else if (cp > end) low = mid + 1;
    else return true;
  }
  return false;
}

function contentReason(value: string, field: TextField): TextReason | undefined {
  for (const char of value) if (!textCodePointAllowed(char.codePointAt(0)!, field)) return 'disallowed-code-point';
  if (value !== value.normalize('NFC')) return 'not-nfc';
  return undefined;
}

/** Stable cross-runtime API. Limits are UTF-16 units: summary/target 200, multiline 2000. */
export function textVerdict(value: unknown, field: TextField): TextVerdict {
  let reason: TextReason | undefined;
  if (typeof value !== 'string') reason = 'not-string';
  else if (value.length === 0) reason = 'empty';
  else if (value.length > (field === 'multiline' ? MAX_ACTION : MAX_SUMMARY)) reason = 'too-long';
  else if (field !== 'multiline' && (value.startsWith(' ') || value.endsWith(' '))) reason = 'edge-whitespace';
  else reason = contentReason(value, field);
  return reason ? { allowed: false, reason } : { allowed: true, reason: null };
}

/** Sweep nested schema strings without imposing a particular field's length/empty rules. */
export function hiddenTextProblem(value: string, multiline = false): string | undefined {
  if (!multiline && value.includes('\n')) return 'disallowed-code-point';
  return contentReason(value, 'multiline');
}

/** Generic schema line (e.g. a timestamp); summary and target use their narrower field verdicts. */
export function plainLineProblem(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return 'not-string';
  if (!value.length) return 'empty';
  if (value.length > max) return 'too-long';
  if (value.startsWith(' ') || value.endsWith(' ')) return 'edge-whitespace';
  return hiddenTextProblem(value);
}

export function plainTextProblem(value: unknown, max: number): string | undefined {
  if (typeof value === 'string' && value.length > max) return 'too-long';
  return textVerdict(value, 'multiline').reason ?? undefined;
}

export function summaryProblem(value: unknown): string | undefined {
  return textVerdict(value, 'summary').reason ?? undefined;
}

export function asciiTargetProblem(value: unknown): string | undefined {
  return textVerdict(value, 'target').reason ?? undefined;
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
