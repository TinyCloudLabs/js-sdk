import { CourierError } from '../errors.js';

/**
 * What an approval names: a verb and a canonical target (spec §7). `courier request` stores them, the owner approves
 * them (both are covered by the request hash), and the guard normalises the command it is about to allow to the same
 * pair. Free text is never compared.
 */
export const VERBS = ['merge', 'deploy', 'publish', 'spend', 'other'] as const;
export type Verb = (typeof VERBS)[number];

const REPO = '[A-Za-z0-9_.-]+';
const SEG = '[A-Za-z0-9_.@/+-]+';
// `[a-z0-9~][a-z0-9._~-]*` per npm; scoped `@scope/name`.
const NPM_NAME = '(?:@[a-z0-9~][a-z0-9._~-]*/)?[a-z0-9~][a-z0-9._~-]*';
const VERSION = '[0-9A-Za-z][0-9A-Za-z.+_-]*';

const bad = (verb: string, raw: string): never => {
  throw new CourierError('usage', `"${raw.slice(0, 80)}" is not a canonical ${verb} target. ${targetHelp(verb)}`);
};

export function targetHelp(verb?: string): string {
  const forms: Record<string, string> = {
    merge: 'merge: owner/repo#<PR number> (or a GitHub PR URL), or owner/repo@<branch> for a direct push to it',
    publish: 'publish: npm:<name>@<version>, release:owner/repo@<tag>, changeset:<root package name>, or script:<package>:<script>',
    deploy: 'deploy: wrangler:<worker>[:<env>], pages:<project>, phala:<name>, or script:<package>:<script>',
    other: 'other: workflow:owner/repo:<workflow file or name>, secrets:<subcommand and key>, or <kind>:<free text>',
    spend: 'spend: spend:<what and how much>',
  };
  return `Targets: ${(verb && forms[verb] ? [forms[verb]] : Object.values(forms)).join('; ')}.`;
}

/**
 * The one spelling of `raw` for `verb`. Repo names are lower-cased; a GitHub PR URL becomes `owner/repo#N`. Throws a
 * CourierError('usage') for anything that is not a recognised, single, printable target.
 */
export function canonicalTarget(verb: string, raw: string): string {
  if (!(VERBS as readonly string[]).includes(verb)) throw new CourierError('usage', `"${verb.slice(0, 40)}" is not a verb; use one of ${VERBS.join(', ')}.`);
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || t.length > 200 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\n]/.test(t)) return bad(verb, String(raw ?? ''));
  let m: RegExpExecArray | null;

  if (verb === 'merge') {
    m = new RegExp(`^https?://github\\.com/(${REPO})/(${REPO})/pull/(\\d+)(?:[/?#].*)?$`, 'i').exec(t);
    if (m) return `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase();
    m = new RegExp(`^(${REPO})/(${REPO})#(\\d+)$`).exec(t);
    if (m) return `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase();
    m = new RegExp(`^(${REPO})/(${REPO})@(${SEG}|\\*)$`).exec(t);
    if (m) return `${m[1]}/${m[2]}`.toLowerCase() + `@${m[3]}`;
    return bad(verb, t);
  }
  if (verb === 'publish') {
    m = new RegExp(`^npm:(${NPM_NAME})@(${VERSION})$`).exec(t);
    if (m) return `npm:${m[1]}@${m[2]}`;
    m = new RegExp(`^release:(${REPO})/(${REPO})@(${SEG})$`).exec(t);
    if (m) return `release:${m[1]}/${m[2]}`.toLowerCase() + `@${m[3]}`;
    m = new RegExp(`^changeset:(${NPM_NAME})$`).exec(t);
    if (m) return `changeset:${m[1]}`;
    m = /^script:([^:\s]+):([^:\s]+)$/.exec(t);
    if (m) return `script:${m[1]}:${m[2]}`;
    return bad(verb, t);
  }
  if (verb === 'deploy') {
    m = /^wrangler:([A-Za-z0-9_.-]+)(?::([A-Za-z0-9_.-]+))?$/.exec(t);
    if (m) return `wrangler:${m[1]}${m[2] ? `:${m[2]}` : ''}`;
    m = /^(pages|phala):([A-Za-z0-9_.-]+)$/.exec(t);
    if (m) return `${m[1]}:${m[2]}`;
    m = /^script:([^:\s]+):([^:\s]+)$/.exec(t);
    if (m) return `script:${m[1]}:${m[2]}`;
    return bad(verb, t);
  }
  if (verb === 'other') {
    m = new RegExp(`^workflow:(${REPO})/(${REPO}):(${SEG})$`).exec(t);
    if (m) return `workflow:${m[1]}/${m[2]}`.toLowerCase() + `:${m[3]}`;
    m = /^secrets:(\S(?:.*\S)?)$/.exec(t);
    if (m) return `secrets:${m[1].replace(/\s+/g, ' ')}`;
    m = /^[a-z][a-z0-9-]{0,30}:\S(?:.*\S)?$/.exec(t);
    if (m) return t;
    return bad(verb, t);
  }
  m = /^spend:\S(?:.*\S)?$/.exec(t);
  return m ? t : bad(verb, t);
}
