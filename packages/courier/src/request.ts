import { CourierError } from './errors.js';
import { canonicalTarget, VERBS, type Verb } from './guard/target.js';

/**
 * What an approval request names, in structured fields (spec §7). They live in `me/requests/<id>.json`, so the
 * request hash covers them; the view renders "Approving lets <peer>'s agent <verb> <target>: <summary>" from them and
 * the guard matches the command it is about to allow to `verb` and `target`, never to free text.
 */
export interface RequestFields {
  verb: Verb;
  /** Canonical form for the verb (see `guard/target.ts`). */
  target: string;
  /** One line for the human, display only; never matched against anything. */
  summary: string;
}

export const MAX_TARGET = 200;
export const MAX_SUMMARY = 200;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** One line: control characters removed, runs of whitespace collapsed. Rejects (rather than truncates) an empty or over-long result. */
export function cleanSummary(raw: string): string {
  const line = raw.replace(/[\t\n\r\u2028\u2029]+/g, ' ').replace(CONTROL_ALL, '').replace(/\s+/g, ' ').trim();
  if (!line) throw new CourierError('usage', '--summary must say, in one line, what is being approved.');
  if (line.length > MAX_SUMMARY) throw new CourierError('usage', `--summary is ${line.length} characters; the limit is ${MAX_SUMMARY}. Shorten it.`);
  return line;
}

/** Validates the three flags of `courier request` and canonicalises the target. */
export function requestFields(input: { verb?: string; target?: string; summary?: string }): RequestFields {
  const { verb, target, summary } = input;
  if (!verb || !(VERBS as readonly string[]).includes(verb)) {
    throw new CourierError('usage', `--verb is required and must be one of: ${VERBS.join(', ')}.`);
  }
  if (!target) throw new CourierError('usage', '--target is required (what is being merged, deployed, published, spent or changed).');
  if (!summary) throw new CourierError('usage', '--summary is required: one line for your owner on what this approves.');
  return { verb: verb as Verb, target: canonicalTarget(verb, target), summary: cleanSummary(summary) };
}

/**
 * The structured fields of a stored request, or undefined if any is missing, mistyped, out of range or carries
 * control characters. A request without them cannot be approved: file a new one.
 */
export function storedRequestFields(request: Record<string, unknown>): RequestFields | undefined {
  const { verb, target, summary } = request;
  if (typeof verb !== 'string' || !(VERBS as readonly string[]).includes(verb)) return undefined;
  if (typeof target !== 'string' || !target || target.length > MAX_TARGET || CONTROL.test(target)) return undefined;
  if (typeof summary !== 'string' || !summary || summary.length > MAX_SUMMARY || CONTROL.test(summary)) return undefined;
  return { verb: verb as Verb, target, summary };
}
