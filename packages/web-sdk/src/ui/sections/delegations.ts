import type {
  DelegationGroup,
  DelegationPage,
  DelegationResource,
  DelegationRow,
  DescribedAbilities,
  PanelDataSource,
  PermissionAbility,
  RevokeOutcome,
  ViewResult,
} from "../data";
import type { ConfirmHandle, DrawerHandle, PanelSection, SectionContext, StatusTone } from "../slots";
import { registerPanelStrings, panelText } from "../strings-panel";
import { DELEGATIONS_STRINGS } from "./delegations.strings";
import { viewStatus } from "./status";
import { actionButton, icon, statusNode, UI_STYLE } from "./ui";
import { applyResult, createStateLine } from "./view-body";

registerPanelStrings(DELEGATIONS_STRINGS);

const DISPLAY = '"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

const STYLE = `
.dl{container-type:inline-size}
.dl-lede{margin:-22px 0 28px;max-width:56ch;font-size:15px;line-height:1.5}
.dl-lede:has(+.dl-fresh:not([hidden])){margin-bottom:10px}
.dl .dl-fresh{margin:0 0 24px;font-size:12.5px}
.dl-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dl-body{display:flex;flex-direction:column;gap:28px}
.dl-h{display:flex;align-items:center;gap:10px;margin:0 0 12px;font:600 13px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em}
.dl-h::after{content:"";flex:1;height:1px;background:#e4e4e7}
.dl-cnt{font-weight:500;color:#71717a}
.dl-sub{margin:-4px 0 12px;font-size:12.5px;line-height:1.4;color:#71717a}
.dl-none{margin:0;font-size:14px;line-height:1.45;color:#71717a}
.dl-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
@container (min-width:720px){.dl-list{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:16px;align-items:start}}
.dl-wrap{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:1fr;transition:grid-template-rows .4s cubic-bezier(.22,1,.36,1),opacity .3s}
.dl-in{min-height:0;padding:3px 3px 12px;margin:-3px -3px 0}
.dl-wrap.dl-leaving{grid-template-rows:0fr;opacity:0}
.dl-wrap.dl-leaving>.dl-in{overflow:hidden;padding-bottom:0}
.dl-card{display:flex;flex-direction:column;gap:10px;padding:16px 16px 16px 18px;border-radius:20px;background:#fff;box-shadow:inset 0 0 0 1px #e4e4e7}
.dl-card:focus{outline:none}
.dl-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.dl-top .st{flex:none}
.dl-name{margin:0;font-size:15px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.dl-kind{display:block;margin-top:2px;font-size:12.5px;font-weight:500;color:#71717a;overflow-wrap:anywhere}
.dl-what{margin:0;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
.dl-meta{margin:0;font-size:13px;color:#71717a}
.dl-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.dl-chip{display:inline-flex;align-items:center;box-sizing:border-box;max-width:100%;min-height:28px;padding:4px 11px;border-radius:999px;background:#f4f4f5;color:#09090b;font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.dl-chip-line{background:transparent;box-shadow:inset 0 0 0 1px #71717a}
.dl-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}
.dl-fine{margin:0;font-size:12.5px;line-height:1.4;color:#71717a}
.dl-msg{margin:0;font-size:13px;line-height:1.4;color:#09090b}
.dl-err{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dl-foot{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin:16px 0 0}
.dl-foot[hidden]{display:none}
.dl-notice{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:28px 22px;border-radius:20px;box-shadow:inset 0 0 0 1px #e4e4e7}
.dl-notice-ask{padding:16px 16px 16px 18px}
.dl-ic{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;box-shadow:inset 0 0 0 1px #71717a}
.dl-notice-ask .dl-ic{width:44px;height:44px}
.dl-ic .ui-ic{width:24px;height:24px}
.dl-notice h4{margin:0;font:400 1.375rem/1.2 ${DISPLAY}}
.dl-notice p{margin:0;max-width:52ch;font-size:14px;line-height:1.45}
.dl-skel{display:flex;flex-direction:column;gap:12px}
.dl-skel-card{height:132px;border-radius:20px;background:#f4f4f5;animation:dl-pulse 1.4s ease-in-out infinite}
.dl-skel-line{height:14px;width:40%;border-radius:7px;background:#f4f4f5;animation:dl-pulse 1.4s ease-in-out infinite}
@keyframes dl-pulse{50%{opacity:.55}}
.dl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dl-kv{display:flex;flex-direction:column;margin:0 0 12px;padding:0}
.dl-kv>div{display:flex;align-items:center;justify-content:space-between;gap:10px;box-sizing:border-box;min-height:44px;padding:0;border-bottom:1px solid #e4e4e7}
.dl-kv>div:last-child{border-bottom:0}
.dl-kv dt{flex:none;font-size:14px}
.dl-kv dd{display:flex;flex:1 1 auto;align-items:center;justify-content:flex-end;gap:2px;min-width:0;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.dl-kv dd.dl-plain{font-weight:400}
.dl-kv dd.dl-mono{font:500 12.5px ${MONO}}
.dl-sub-h{margin:12px 0 8px;font-size:13px;font-weight:600}
.dl-res{display:flex;flex-direction:column;gap:8px;margin:0 0 12px;padding:0;list-style:none}
.dl-res>li{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-radius:12px;background:#f4f4f5}
.dl-res code{font:600 12px ${MONO};overflow-wrap:anywhere}
.dl-res .dl-chips{gap:4px}
.dl-res .dl-chip{min-height:24px;padding:4px 9px;background:#fff;font-size:12px;line-height:1}
.section[data-section="delegations"] .confirm{margin-top:10px;padding:14px 16px;border-radius:16px;box-shadow:inset 0 0 0 1px #71717a}
.section[data-section="delegations"] .confirm p{margin:0;font-size:14px;line-height:1.45;color:inherit}
.section[data-section="delegations"] .confirm .actions .action:last-child,.section[data-section="delegations"] .confirm .actions .action:last-child:hover{border-color:#09090b;background:#09090b;color:#fff}
.dl-q-title{display:block;margin-bottom:6px;font:400 1.25rem/1.25 ${DISPLAY}}
.dl-q-dim{display:block;margin-top:8px;color:#52525b}
.drawer .dl-what{margin:0 0 8px}
@media (prefers-reduced-motion:reduce){
.dl-wrap{transition:none}
.dl-skel-card,.dl-skel-line{animation:none}
}
@media (prefers-color-scheme: dark){
.dl-h::after{background:#69696b}
.dl-cnt,.dl-sub,.dl-none,.dl-kind,.dl-meta,.dl-fine{color:#a1a1aa}
.dl-card{background:#151517;box-shadow:inset 0 0 0 1px #69696b}
.dl-msg{color:#fafafa}
.dl-chip{background:#27272a;color:#fafafa}
.dl-chip-line{background:transparent;box-shadow:inset 0 0 0 1px #a1a1aa}
.dl-notice{box-shadow:inset 0 0 0 1px #69696b}
.dl-ic{box-shadow:inset 0 0 0 1px #a1a1aa}
.dl-skel-card,.dl-skel-line{background:#27272a}
.dl-kv>div{border-bottom-color:#69696b}
.dl-res>li{background:#27272a}
.dl-res .dl-chip{height:24px;padding:0 9px;background:#151517}
.section[data-section="delegations"] .confirm{box-shadow:inset 0 0 0 1px #a1a1aa}
.section[data-section="delegations"] .confirm .actions .action:last-child,.section[data-section="delegations"] .confirm .actions .action:last-child:hover{border-color:#fafafa;background:#fafafa;color:#09090b}
.dl-q-dim{color:#d4d4d8}
}
`;

// ---------------------------------------------------------------------------
// Plain-words abilities
// ---------------------------------------------------------------------------

type Verb = "read" | "write" | "list" | "delete";
const VERBS: readonly Verb[] = ["read", "write", "list", "delete"];

/** Known action names, with and without the service prefix. Looked up by own key only, so `constructor` and friends are plain unknown actions. */
const KNOWN_ACTIONS: Readonly<Record<string, Verb>> = {
  "tinycloud.kv/get": "read",
  "tinycloud.kv/put": "write",
  "tinycloud.kv/list": "list",
  "tinycloud.kv/del": "delete",
  get: "read",
  put: "write",
  list: "list",
  del: "delete",
};

const MAX_RAW = 64;

/** Text that came from the network, made safe to show: no control or bidi characters, bounded. */
function clean(value: string, max = MAX_RAW): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, max);
}

interface ParsedResource {
  readonly space?: string;
  /** Empty when the grant covers everything in the space. */
  readonly path: string;
  readonly verbs: readonly Verb[];
  /** Actions the table does not know, shown as they are. */
  readonly raws: readonly string[];
}

const SERVICE_PATH = /^(.*?)\/(?:kv|sql|duckdb|hooks|vault)(?:\/(.*))?$/;
const BARE_PATH = /^tinycloud\.[a-z]+\/(.*)$/i;

function splitResource(resource: string): { space?: string; path: string } {
  const bare = BARE_PATH.exec(resource);
  if (bare) return { path: (bare[1] ?? "") === "/" ? "" : (bare[1] ?? "") };
  const full = SERVICE_PATH.exec(resource);
  if (full) {
    const tail = (full[1] ?? "").split(/[:/]/).pop() ?? "";
    const space = tail === "" || /^0x[0-9a-f]{16,}$/i.test(tail) ? undefined : tail;
    const path = full[2] ?? "";
    return { ...(space === undefined ? {} : { space }), path: path === "/" ? "" : path };
  }
  return { path: resource === "/" ? "" : resource };
}

/** Reads a resource list that may be malformed. Never throws. */
function parseResources(resources: readonly DelegationResource[]): ParsedResource[] {
  const parsed: ParsedResource[] = [];
  if (!Array.isArray(resources)) return parsed;
  for (const entry of resources) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = "resource" in entry ? entry.resource : undefined;
    const actions = "actions" in entry ? entry.actions : undefined;
    if (typeof raw !== "string" || !Array.isArray(actions)) continue;
    const verbs = new Set<Verb>();
    const raws: string[] = [];
    for (const action of actions) {
      if (typeof action !== "string") continue;
      const key = action.trim().toLowerCase();
      const verb = Object.prototype.hasOwnProperty.call(KNOWN_ACTIONS, key) ? KNOWN_ACTIONS[key] : undefined;
      if (verb !== undefined) verbs.add(verb);
      else {
        const shown = clean(action);
        if (shown !== "" && !raws.includes(shown)) raws.push(shown);
      }
    }
    const where = splitResource(clean(raw, 200));
    parsed.push({
      ...(where.space === undefined ? {} : { space: where.space }),
      path: where.path,
      verbs: VERBS.filter((verb) => verbs.has(verb)),
      raws,
    });
  }
  return parsed;
}

function joinList(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")}${panelText("delegations.ability.and")}${items[items.length - 1] ?? ""}`;
}

function uniq(items: readonly string[]): string[] {
  return items.filter((item, at) => items.indexOf(item) === at);
}

/** "read and list notes/", the part after "Can". Empty when the grant lists no action. */
function abilityClause(parsed: readonly ParsedResource[]): string {
  const groups = new Map<string, { words: string[]; paths: string[] }>();
  for (const resource of parsed) {
    const words = [...resource.verbs.map((verb) => panelText(`delegations.verb.${verb}`)), ...resource.raws];
    if (words.length === 0) continue;
    const key = words.join("\u0000");
    const group = groups.get(key) ?? { words, paths: [] };
    group.paths.push(resource.path === "" ? panelText("delegations.ability.all") : resource.path);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => `${joinList(group.words)} ${joinList(uniq(group.paths))}`)
    .join(panelText("delegations.ability.sep"));
}

/** Entries of a resource list that cannot be read: not an object, no resource, or actions that are not a list of names. */
function unreadableIn(resources: unknown): number {
  if (!Array.isArray(resources)) return 1;
  let count = 0;
  for (const entry of resources) {
    const readable =
      typeof entry === "object" &&
      entry !== null &&
      "resource" in entry &&
      typeof entry.resource === "string" &&
      "actions" in entry &&
      Array.isArray(entry.actions) &&
      entry.actions.every((action: unknown) => typeof action === "string");
    if (!readable) count += 1;
  }
  return count;
}

/** `abilityClause`, said plainly when part of the list could not be read: what is known, and that there is more. */
function clauseOf(resources: readonly DelegationResource[]): string {
  const clause = abilityClause(parseResources(resources));
  return clause !== "" && unreadableIn(resources) > 0 ? `${clause}${panelText("delegations.ability.more")}` : clause;
}

/**
 * Plain-words rendering of a resource list. `tinycloud.kv/get` reads as "read",
 * `put` as "write", `list` as "list", `del` as "delete". Any other action is
 * shown as it is (cleaned and shortened) in the line and in `chips`. An empty
 * list says no actions are listed; a list that cannot be read says the abilities
 * are unknown, never "none". This never throws.
 */
export function describeAbilities(resources: readonly DelegationResource[]): DescribedAbilities {
  try {
    const parsed = parseResources(resources);
    const clause = clauseOf(resources);
    const chips = [
      ...VERBS.filter((verb) => parsed.some((resource) => resource.verbs.includes(verb))).map((verb) =>
        panelText(`delegations.chip.${verb}`),
      ),
      ...uniq(parsed.flatMap((resource) => resource.raws)),
    ];
    const none = unreadableIn(resources) > 0 ? "delegations.ability.unknown" : "delegations.ability.none";
    return {
      plain: clause === "" ? panelText(none) : panelText("delegations.ability.can", { what: clause }),
      chips,
    };
  } catch {
    return { plain: panelText("delegations.ability.unknown"), chips: [] };
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Shown = "active" | "soon" | "expired" | "revoked" | "pending" | "unknown";

const SHOWN_TONE: Record<Shown, StatusTone> = {
  active: "ok",
  soon: "warn",
  expired: "info",
  revoked: "info",
  pending: "off",
  unknown: "info",
};

/** What the card says. An active grant whose end has passed reads as expired, so it offers no revoke. */
export function shownStatus(row: DelegationRow, now: number): Shown {
  switch (row.status) {
    case "active": {
      const end = row.expiresAt?.getTime();
      if (end !== undefined && !Number.isNaN(end) && end <= now) return "expired";
      return row.expiringSoon ? "soon" : "active";
    }
    case "expired":
      return "expired";
    case "revoked":
    case "ancestor_revoked":
      return "revoked";
    case "pending":
      return "pending";
    default:
      // A status this panel does not know is not "not active yet" or anything else specific.
      return "unknown";
  }
}

const revocable = (shown: Shown): boolean => shown === "active" || shown === "soon";

/** A grant someone else gave the user. The mapper sets both fields; either one marks it. */
const isReceived = (row: DelegationRow): boolean => row.group === "received" || row.direction === "received";

/** Only grants the user gave can be revoked here. A received grant is read-only: the user would be the one losing access, and there is nothing for them to consent to. */
const canRevoke = (row: DelegationRow, now: number): boolean => revocable(shownStatus(row, now)) && !isReceived(row);

const GROUPS: readonly DelegationGroup[] = ["this-app", "to-others", "received"];

/** Rows by group, in the order the page lists them. */
export function groupRows(rows: readonly DelegationRow[]): Record<DelegationGroup, DelegationRow[]> {
  const grouped: Record<DelegationGroup, DelegationRow[]> = { "this-app": [], "to-others": [], received: [] };
  for (const row of rows) grouped[isReceived(row) ? "received" : GROUPS.includes(row.group) ? row.group : "to-others"].push(row);
  return grouped;
}

function shortDid(did: string): string {
  const shown = clean(did, 200);
  return shown.length <= 22 ? shown : `${shown.slice(0, 14)}…${shown.slice(-6)}`;
}

function shortCid(cid: string): string {
  const shown = clean(cid, 200);
  return shown.length <= 16 ? shown : `${shown.slice(0, 10)}…${shown.slice(-4)}`;
}

/** The other party: who got access from you, or who gave it to you. */
function counterpart(row: DelegationRow): string {
  return isReceived(row) ? row.delegatorDid : row.delegateDid;
}

function displayName(row: DelegationRow): string {
  const label = clean(row.label?.text ?? "", 120);
  // The mapper names every row after its delegate; for a received grant the other party is the delegator.
  const who = isReceived(row) && (label === "" || label === shortDid(row.delegateDid)) ? shortDid(row.delegatorDid) : label === "" ? shortDid(counterpart(row)) : label;
  return who === "" ? panelText("delegations.party.unknown") : who;
}

function spacesOf(parsed: readonly ParsedResource[]): string[] {
  return uniq(parsed.flatMap((resource) => (resource.space === undefined ? [] : [resource.space])));
}

function relative(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const NBSP = "\u00a0";
  if (days > 0) return hours > 0 ? `${days}d${NBSP}${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${NBSP}${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function agoText(from: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - from.getTime()) / 60_000));
  if (minutes < 1) return panelText("delegations.time.now");
  if (minutes < 60) return panelText("delegations.time.min", { n: minutes });
  if (minutes < 1440) return panelText("delegations.time.hour", { n: Math.floor(minutes / 60) });
  return panelText("delegations.time.day", { n: Math.floor(minutes / 1440) });
}

function validDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/** A creation time this far ahead of now is a clock disagreement, not a time; it is treated as unknown rather than shown as "just now". */
const CLOCK_SKEW_MS = 5 * 60_000;

/** Unknown is never shown as a value: a missing space, creation time or expiry says so. A grant that does not expire is not told apart from one whose end is not recorded, because the record cannot. */
function metaLine(row: DelegationRow, shown: Shown, parsed: readonly ParsedResource[], now: number): string {
  const parts: string[] = [];
  const spaces = spacesOf(parsed);
  if (spaces.length === 1) parts.push(panelText("delegations.meta.space", { space: spaces[0] ?? "" }));
  else if (spaces.length > 1) parts.push(panelText("delegations.meta.spaces", { count: spaces.length }));
  else parts.push(panelText("delegations.meta.space.unknown"));
  if (validDate(row.issuedAt) && row.issuedAt.getTime() <= now + CLOCK_SKEW_MS) {
    parts.push(panelText("delegations.meta.created", { when: agoText(row.issuedAt, now) }));
  } else parts.push(panelText("delegations.meta.created.unknown"));
  if (validDate(row.expiresAt)) {
    const gone = row.expiresAt.getTime() <= now;
    const when = panelText(gone ? "delegations.time.ago" : "delegations.time.in", { t: relative(row.expiresAt.getTime() - now) });
    parts.push(panelText(gone || shown === "expired" ? "delegations.meta.expired" : "delegations.meta.expires", { when }));
  } else parts.push(panelText("delegations.meta.expires.unknown"));
  return parts.join(panelText("delegations.meta.sep"));
}

function kindLine(row: DelegationRow, name: string): string {
  if (isReceived(row)) return panelText("delegations.kind.received", { who: name });
  const kind = panelText(row.group === "this-app" ? "delegations.kind.app" : "delegations.kind.others");
  const who = shortDid(counterpart(row));
  return who === name ? kind : `${kind}${panelText("delegations.meta.sep")}${who}`;
}

/** Codes for a grant that was not active, or no longer there, at the moment of revoking. */
const STALE_CODES: Readonly<Record<string, true>> = {
  "not-revocable": true,
  NOT_FOUND: true,
  not_found: true,
  "not-found": true,
  "not-active": true,
};
const DENIED_CODES: Readonly<Record<string, true>> = { PERMISSION_DENIED: true, "permission-denied": true, denied: true };
/** The request may or may not have reached the node: the outcome is not known. "thrown" is the section's own code for an exception. */
const UNCONFIRMED_CODES: Readonly<Record<string, true>> = { NETWORK_ERROR: true, ABORTED: true, thrown: true };

type Phase = "idle" | "busy" | "failed" | "denied" | "stale" | "unconfirmed";

/** Which message a refused revoke maps to. Anything else, REVOCATION_FAILED included, is a plain failure. */
export function refusalPhase(code: string): Exclude<Phase, "idle" | "busy"> {
  if (Object.prototype.hasOwnProperty.call(STALE_CODES, code)) return "stale";
  if (Object.prototype.hasOwnProperty.call(DENIED_CODES, code)) return "denied";
  if (Object.prototype.hasOwnProperty.call(UNCONFIRMED_CODES, code)) return "unconfirmed";
  return "failed";
}


// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className !== undefined) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Card {
  readonly cid: string;
  row: DelegationRow;
  phase: Phase;
  confirm: ConfirmHandle | undefined;
  drawer: DrawerHandle | undefined;
  detail: HTMLElement | undefined;
  readonly li: HTMLLIElement;
  readonly article: HTMLElement;
  readonly name: HTMLElement;
  readonly kind: HTMLElement;
  readonly statusSlot: HTMLElement;
  readonly what: HTMLElement;
  readonly meta: HTMLElement;
  readonly chips: HTMLUListElement;
  readonly see: HTMLButtonElement;
  readonly revoke: HTMLButtonElement;
  readonly ended: HTMLElement;
  readonly busy: HTMLElement;
  readonly err: HTMLElement;
  readonly errText: HTMLElement;
  readonly retry: HTMLButtonElement;
  readonly reload: HTMLButtonElement;
}

let cardSeq = 0;

/**
 * CIDs with a revoke in flight, across mounts. Closing the panel unmounts the section, but the request goes on;
 * a new mount must not ask the node to revoke the same grant again. Cleared when the request settles.
 */
const IN_FLIGHT = new Set<string>();

/** CIDs revoked from this panel, per data cache. The node's list keeps a revoked grant as a row; the panel shows it gone, in the body and in the rail count. */
const REVOKED_HERE = new WeakMap<object, Set<string>>();
function revokedFrom(data: object): Set<string> {
  const known = REVOKED_HERE.get(data);
  if (known !== undefined) return known;
  const made = new Set<string>();
  REVOKED_HERE.set(data, made);
  return made;
}

/**
 * Delegations the account granted or received, as cards by group. Reads the
 * shell's cache (`ctx.data`), so the rail count and the body never disagree.
 * Revoke asks first (the safe action takes focus), then calls the data source,
 * which checks the node's current status before and after.
 */
function mountDelegations(el: HTMLElement, ctx: SectionContext): () => void {
  const text = (code: string, params?: Readonly<Record<string, string | number>>): string => ctx.text(code, params);
  const appName = (): string => ctx.appLabel() ?? text("delegations.app.fallback");
  const appSubject = (): string => ctx.appLabel() ?? text("delegations.app.subject");
  const partyName = (row: DelegationRow): string => (row.group === "this-app" ? appSubject() : displayName(row));

  const style = node("style");
  style.textContent = UI_STYLE + STYLE;
  const root = node("div", "dl");
  const title = node("h3", "sec-title", text("nav.delegations"));
  title.tabIndex = -1;
  const lede = node("p", "dl-lede", text("delegations.lede"));
  const live = node("div", "dl-live");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  const skeleton = node("div", "dl-skel");
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-busy", "true");
  skeleton.append(
    node("span", "dl-sr", text("delegations.loading")),
    node("div", "dl-skel-line"),
    node("div", "dl-skel-card"),
  );
  const notice = node("div");
  const body = node("div", "dl-body");
  const foot = node("div", "dl-foot");
  const footNote = node("p", "dl-fine");
  const showMore = actionButton(text("delegations.more.btn"));
  const footErr = node("p", "dl-msg");
  footErr.setAttribute("role", "alert");
  footErr.hidden = true;
  foot.append(footNote, showMore, footErr);
  showMore.addEventListener("click", () => void loadMore());
  // The retry the helper builds is not used: this section has its own for a failed read.
  const fresh = createStateLine(ctx, () => undefined);
  fresh.status.classList.add("dl-fresh");
  root.append(title, lede, fresh.status, live, skeleton, notice, body);
  el.append(style, root);

  let disposed = false;
  let reloading = false;
  // Moves on whenever the list is dropped (see `update`). Anything in flight remembers the value it started under.
  let epoch = 0;
  let retryId = 0;
  let started = false;
  let lastSource: PanelDataSource | undefined;
  let lastResult: ViewResult<DelegationPage> | undefined;
  let declined = false;
  // The first page is the cache's. Pages after it are read here, kept apart, and dropped when the list goes.
  let firstPage: DelegationPage | undefined;
  let extra: DelegationRow[] = [];
  let extraCursor: { next: string | undefined } | undefined;
  let paging: "idle" | "loading" | "error" = "idle";
  const cards = new Map<string, Card>();
  const removed = revokedFrom(ctx.data);
  const timers = new Set<number>();

  // --- groups -------------------------------------------------------------
  interface GroupView {
    readonly section: HTMLElement;
    readonly count: HTMLElement;
    readonly list: HTMLUListElement;
    readonly none: HTMLElement;
  }
  const groupViews = new Map<DelegationGroup, GroupView>();

  function groupView(group: DelegationGroup): GroupView {
    const known = groupViews.get(group);
    if (known !== undefined) return known;
    const code = group === "this-app" ? "app" : group === "to-others" ? "others" : "received";
    const section = node("section");
    const heading = node("h3", "dl-h");
    const label = node("span", undefined, text(`delegations.g.${code}`, { app: appName() }));
    const count = node("span", "dl-cnt");
    heading.append(label, count);
    const sub = node("p", "dl-sub", text(`delegations.g.${code}.sub`, { app: appName() }));
    const list = node("ul", "dl-list");
    const none = node("p", "dl-none", text("delegations.g.none"));
    section.append(heading, sub, list, none);
    const made = { section, count, list, none };
    groupViews.set(group, made);
    return made;
  }

  // --- cards --------------------------------------------------------------
  function buildCard(row: DelegationRow): Card {
    const id = `dl-${++cardSeq}`;
    const li = node("li", "dl-wrap");
    const inner = node("div", "dl-in");
    const article = node("article", "dl-card");
    article.tabIndex = -1;
    const top = node("div", "dl-top");
    const name = node("div", "dl-name");
    name.id = `${id}-n`;
    const kind = node("small", "dl-kind");
    const nameText = node("span");
    name.append(nameText, kind);
    const statusSlot = node("span");
    top.append(name, statusSlot);
    const what = node("p", "dl-what");
    const meta = node("p", "dl-meta");
    const chips = node("ul", "dl-chips");
    const acts = node("div", "dl-acts");
    const see = actionButton(text("delegations.see"));
    const revoke = actionButton(text("delegations.revoke.btn"));
    const ended = node("span", "dl-fine");
    acts.append(see, revoke, ended);
    const busy = node("p", "dl-msg", text("delegations.busy"));
    busy.setAttribute("role", "status");
    const err = node("div", "dl-err");
    err.setAttribute("role", "alert");
    const errText = node("p", "dl-msg");
    const retry = actionButton(text("view.retry"));
    const reload = actionButton(text("delegations.reload"));
    reload.hidden = true;
    err.append(errText, retry, reload);
    article.setAttribute("aria-labelledby", name.id);
    article.append(top, what, meta, chips, acts, busy, err);
    inner.append(article);
    li.append(inner);

    const card: Card = {
      cid: row.cid,
      row,
      phase: "idle",
      confirm: undefined,
      drawer: undefined,
      detail: undefined,
      li,
      article,
      name: nameText,
      kind,
      statusSlot,
      what,
      meta,
      chips,
      see,
      revoke,
      ended,
      busy,
      err,
      errText,
      retry,
      reload,
    };
    see.addEventListener("click", () => openDetails(card));
    revoke.addEventListener("click", () => askRevoke(card));
    retry.addEventListener("click", () => askRevoke(card));
    reload.addEventListener("click", () => void reloadList());
    return card;
  }

  function paint(card: Card): void {
    const now = Date.now();
    const { row } = card;
    const shown = shownStatus(row, now);
    const parsed = parseResources(row.resources);
    const name = displayName(row);
    card.name.textContent = name;
    card.kind.textContent = kindLine(row, name);
    card.statusSlot.replaceChildren(statusNode({ text: text(`delegations.st.${shown}`), tone: SHOWN_TONE[shown] }));
    card.what.textContent = describeAbilities(row.resources).plain;
    card.meta.textContent = metaLine(row, shown, parsed, now);

    const described = describeAbilities(row.resources);
    const chips = described.chips.map((chip) => node("li", "dl-chip", chip));
    if (row.terminal === true) {
      const terminal = node("li", "dl-chip dl-chip-line", text("delegations.chip.terminal"));
      terminal.title = text("delegations.chip.terminal.tip");
      chips.push(terminal);
    }
    card.chips.replaceChildren(...chips);
    card.chips.hidden = chips.length === 0;

    card.see.setAttribute("aria-label", text("delegations.see.for", { name }));
    const mayRevoke = canRevoke(row, now);
    card.revoke.hidden = !mayRevoke;
    card.revoke.disabled = IN_FLIGHT.has(card.cid);
    card.revoke.setAttribute("aria-label", text("delegations.revoke.for", { name }));
    card.ended.hidden = mayRevoke;
    if (!mayRevoke) {
      card.ended.textContent = text(
        revocable(shown)
          ? "delegations.ended.received"
          : shown === "expired"
            ? "delegations.ended.expired"
            : shown === "revoked"
              ? "delegations.ended.revoked"
              : shown === "unknown"
                ? "delegations.ended.unknown"
                : "delegations.ended.pending",
      );
    }

    // A revoke started by an earlier mount of this section still counts: the panel may have been closed and opened again.
    // The lock is per grant: other grants stay revocable while this one's request is out.
    const locked = IN_FLIGHT.has(card.cid);
    const busy = card.phase === "busy" || locked;
    card.busy.hidden = !busy;
    const refused = card.phase === "failed" || card.phase === "denied" || card.phase === "stale" || card.phase === "unconfirmed";
    card.err.hidden = !refused;
    // Only the first page is re-read after a failure, so for a row that came from a later page the card cannot claim the list says where it stands.
    const later = firstPage !== undefined && !firstPage.rows.some((r) => r.cid === card.cid);
    if (refused) {
      // After a failed try the row may have ended anyway; say what the fresh read shows, not what the failure implied.
      const ended = !mayRevoke && !later && (card.phase === "failed" || card.phase === "unconfirmed");
      card.errText.textContent = text(`delegations.err.${ended ? "ended" : card.phase === "unconfirmed" && later ? "unconfirmed.later" : card.phase}`);
    }
    card.reload.hidden = !(refused && card.phase === "unconfirmed" && later);
    card.retry.hidden = (card.phase !== "failed" && card.phase !== "unconfirmed") || !mayRevoke;
    card.retry.disabled = locked;
    if (card.detail !== undefined) card.detail.replaceChildren(...detailRows(row, shown, now));
  }

  function paintAll(): void {
    for (const card of cards.values()) paint(card);
  }

  function closeConfirm(card: Card): void {
    card.confirm?.close();
    card.confirm = undefined;
  }

  function closeOtherConfirms(keep?: Card): void {
    for (const card of cards.values()) if (card !== keep) closeConfirm(card);
  }

  // --- revoke -------------------------------------------------------------
  function askRevoke(card: Card): void {
    if (IN_FLIGHT.has(card.cid) || card.phase === "busy") return;
    if (!canRevoke(card.row, Date.now())) return;
    closeOtherConfirms();
    closeConfirm(card);
    card.phase = "idle";
    paint(card);

    const thisApp = card.row.group === "this-app";
    // For the app's own grant the party losing access is the app, on this device; the DID would name nobody the user knows.
    const name = partyName(card.row);
    const parsed = parseResources(card.row.resources);
    const spaces = spacesOf(parsed);
    const where = spaces.length === 1 ? text("delegations.confirm.where", { space: spaces[0] ?? "" }) : "";
    const clause = clauseOf(card.row.resources);
    const heading = text(thisApp ? "delegations.confirm.title.app" : "delegations.confirm.title", { name });
    const consequence =
      clause === ""
        ? text("delegations.confirm.generic", { name, where })
        : text("delegations.confirm.what", { name, what: clause, where });
    const detail = thisApp ? `${consequence} ${text("delegations.confirm.after.app", { name })}` : consequence;
    const wallet = text("delegations.confirm.openkey");

    const handle = ctx.confirm({
      question: `${heading} ${detail} ${wallet}`,
      cancelLabel: text("delegations.confirm.keep"),
      confirmLabel: text("delegations.confirm.go"),
      anchor: card.article,
      onCancel: () => {
        card.confirm = undefined;
        if (!disposed && card.revoke.isConnected && !card.revoke.hidden) card.revoke.focus();
      },
      onConfirm: () => void doRevoke(card),
    });
    card.confirm = handle;

    // Same words, laid out as a heading, the consequence and the wallet note; the dialog is named by its question.
    const box = handle.cancel.closest<HTMLElement>('[role="alertdialog"]');
    const question = box?.querySelector("p");
    if (box !== null && box !== undefined && question !== null && question !== undefined) {
      const id = `dl-${++cardSeq}`;
      const head = node("span", "dl-q-title", heading);
      head.id = `${id}-t`;
      const body = node("span", undefined, detail);
      body.id = `${id}-b`;
      const dim = node("span", "dl-q-dim", wallet);
      dim.id = `${id}-w`;
      question.replaceChildren(head, body, dim);
      box.setAttribute("aria-labelledby", head.id);
      box.setAttribute("aria-describedby", `${body.id} ${dim.id}`);
    }
  }

  async function doRevoke(card: Card): Promise<void> {
    if (IN_FLIGHT.has(card.cid) || card.phase === "busy") return;
    const confirmed = card.confirm;
    if (confirmed !== undefined) confirmed.confirm.disabled = true;
    const source = ctx.data.source;
    // Re-check at the moment of consent: the row may have changed since the box opened.
    if (source === undefined || !canRevoke(card.row, Date.now())) {
      closeConfirm(card);
      card.phase = "stale";
      paint(card);
      void settleList();
      // The activated button just went away; the heading is a steady place for focus.
      title.focus({ preventScroll: true });
      return;
    }
    closeConfirm(card);
    const mine = epoch;
    const account = watchAccount();
    IN_FLIGHT.add(card.cid);
    card.phase = "busy";
    paintAll();
    card.article.focus();

    let outcome: RevokeOutcome | undefined;
    try {
      outcome = await source.revoke(card.cid);
    } catch {
      outcome = { ok: false, code: "thrown" };
    } finally {
      IN_FLIGHT.delete(card.cid);
      account.stop();
    }
    const ok = outcome !== undefined && outcome.ok === true;

    // The account changed while the node was answering: the write was for the OLD account's grant. Its outcome is not shown
    // as the new account's: no receipt, no row or count change, no failure line on the new list, no re-read for it. One
    // neutral toast says it finished (or did not).
    if (account.moved()) {
      if (ctx.toastsEnabled()) ctx.toast({ kind: "info", textCode: ok ? "delegations.prev.ok" : "delegations.prev.failed" });
      if (!disposed) destroy(card);
      // The grant's lock is released: let every mounted list (the new account's card for the same ID, if any) repaint it.
      // This repaints; it does not re-read.
      ctx.requestRender();
      return;
    }

    // The answer is for a grant of the list that was on screen when the user confirmed. It still has to be reported: a
    // revoke that went through is a fact (receipt), one that failed is something to be told. But it is not painted into
    // a list that has since been replaced.
    const sameList = !disposed && mine === epoch;

    if (ok) {
      removed.add(card.cid);
      ctx.requestRender();
      receipt(card);
      void settleList();
      if (disposed) return;
      if (!sameList) {
        destroy(card);
        return;
      }
      live.textContent = text("delegations.live.revoked", { name: partyName(card.row) });
      leave(card);
      return;
    }
    const code = outcome !== undefined && outcome.ok === false ? outcome.code : "thrown";
    card.phase = refusalPhase(code);
    // Whatever went wrong, re-read the list so the card shows where the grant really stands.
    void settleList();
    if (!sameList) {
      // The panel was closed, or the list replaced, while the node answered; the failure still has to be seen.
      if (ctx.toastsEnabled()) ctx.toast({ kind: "error", textCode: `delegations.err.${card.phase}` });
      if (!disposed) destroy(card);
      return;
    }
    paintAll();
    if (card.retry.hidden) card.article.focus();
    else card.retry.focus();
  }

  /** Whether the account changed since this was called: the cache was cleared or its data source swapped. It listens on its own, so it still sees the change after the section has gone. */
  function watchAccount(): { moved(): boolean; stop(): void } {
    const source = ctx.data.source;
    let last = ctx.data.latest("delegations");
    let moved = false;
    const off = ctx.data.subscribe(() => {
      const now = ctx.data.latest("delegations");
      if (now === undefined && last !== undefined) moved = true;
      last = now;
    });
    return { moved: () => moved || ctx.data.source !== source, stop: off };
  }

  /** The slip: the delegation's CID and the time. The receipt id does not exist, so the CID is the only identifier. */
  function receipt(card: Card): void {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const name = partyName(card.row);
    const suffix = card.row.group === "this-app" ? ".app" : "";
    const clause = clauseOf(card.row.resources);
    const sentence =
      clause === ""
        ? text(`delegations.receipt.generic${suffix}`, { name })
        : text(`delegations.receipt.what${suffix}`, { name, what: clause });
    // The slip's body is a string code with no parameters, so a sentence reaches it as a registered template and is
    // interpolated once more. Text that came from the network must not go through that: a brace in it (`App {constructor}`)
    // would be read as a placeholder. Such a sentence is kept out of the body; the name goes in a row, which is shown as data.
    const literal = sentence.includes("{");
    if (!literal) registerPanelStrings({ "delegations.receipt.sentence": sentence });
    const shown = ctx.receipt({
      titleCode: "delegations.receipt.title",
      bodyCode: literal ? "delegations.receipt.body" : "delegations.receipt.sentence",
      rows: [
        ...(literal ? [{ labelCode: "delegations.receipt.for", value: name }] : []),
        // The whole CID: the slip copies what it shows, and a shortened identifier would not find the delegation again.
        { labelCode: "delegations.receipt.cid", value: clean(card.cid, 200) },
        { labelCode: "delegations.receipt.time", value: time },
      ],
    });
    if (!shown && ctx.toastsEnabled()) ctx.toast({ kind: "success", textCode: "delegations.receipt.title" });
  }

  /** Re-reads the first page so counts, statuses and the rail follow the node. */
  async function settleList(): Promise<void> {
    try {
      await ctx.data.refresh("delegations");
    } catch {
      // The cache records a failed read as an error result; nothing to add here.
    }
  }

  /** Drops the pages read after the first and reads the first page again: the only way to see where a later-page row stands. */
  async function reloadList(): Promise<void> {
    const mine = ++epoch;
    extra = [];
    extraCursor = undefined;
    paging = "idle";
    update();
    await settleList();
    if (disposed || mine !== epoch) return;
    title.focus({ preventScroll: true });
  }

  function leave(card: Card): void {
    cards.delete(card.cid);
    closeConfirm(card);
    card.drawer?.close();
    card.drawer = undefined;
    const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
    if (active !== null && card.li.contains(active)) title.focus({ preventScroll: true });
    const finish = (): void => card.li.remove();
    if (reducedMotion()) finish();
    else {
      card.li.classList.add("dl-leaving");
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        finish();
      }, 420);
      timers.add(timer);
    }
    update();
  }

  // --- details ------------------------------------------------------------
  function copyButton(value: string, labelCode: string): HTMLButtonElement {
    const button = node("button", "icon-btn");
    button.type = "button";
    button.setAttribute("aria-label", text(labelCode));
    button.append(icon("copy"));
    button.addEventListener("click", () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(value);
          ctx.toast({ kind: "success", textCode: "toast.copied" });
        } catch {
          ctx.toast({ kind: "error", textCode: "toast.copy_failed" });
        }
      })();
    });
    return button;
  }

  function kvRow(labelCode: string, value: string): HTMLElement {
    const line = node("div");
    line.append(node("dt", undefined, text(labelCode)), node("dd", "dl-plain", value));
    return line;
  }

  function idRow(labelCode: string, id: string, shortForm: string, copyCode: string): HTMLElement {
    // An identity that is missing is unknown, not an empty value with a copy button.
    if (id === "") return kvRow(labelCode, text("delegations.d.none"));
    const line = node("div");
    const dd = node("dd", "dl-mono");
    dd.append(node("span", undefined, shortForm), copyButton(id, copyCode));
    line.append(node("dt", undefined, text(labelCode)), dd);
    return line;
  }

  function dateText(date: Date | null | undefined): string {
    return validDate(date) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : text("delegations.d.none");
  }

  function detailRows(row: DelegationRow, shown: Shown, now: number): Node[] {
    const all = parseResources(row.resources);
    const summary = node(
      "p",
      "dl-what",
      `${describeAbilities(row.resources).plain}${row.terminal === true ? `. ${text("delegations.d.noforward")}` : "."}`,
    );
    const list = node("dl", "dl-kv");
    const status = node("dd");
    status.append(statusNode({ text: text(`delegations.st.${shown}`), tone: SHOWN_TONE[shown] }));
    const statusLine = node("div");
    statusLine.append(node("dt", undefined, text("delegations.d.status")), status);
    list.append(
      statusLine,
      idRow("delegations.d.by", row.delegatorDid, shortDid(row.delegatorDid), "delegations.d.copy.by"),
      idRow("delegations.d.to", row.delegateDid, shortDid(row.delegateDid), "delegations.d.copy.to"),
      idRow("delegations.d.id", row.cid, shortCid(row.cid), "delegations.d.copy.id"),
      kvRow("delegations.d.issued", dateText(row.issuedAt)),
      kvRow("delegations.d.notbefore", dateText(row.notBefore)),
      kvRow(
        validDate(row.expiresAt) && row.expiresAt.getTime() <= now ? "delegations.d.expired" : "delegations.d.expires",
        dateText(row.expiresAt),
      ),
      kvRow(
        "delegations.d.parents",
        !Array.isArray(row.parents)
          ? text("delegations.d.none")
          : row.parents.length === 0
            ? text("delegations.d.parents.none")
            : text("delegations.d.parents.n", { count: row.parents.length }),
      ),
    );
    const spaces = spacesOf(all);
    list.insertBefore(kvRow("delegations.d.space", spaces.length === 0 ? text("delegations.d.none") : spaces.join(", ")), list.children[1] ?? null);
    if (row.terminal !== undefined) {
      list.append(kvRow("delegations.d.terminal", text(row.terminal ? "delegations.d.terminal.yes" : "delegations.d.terminal.no")));
    }
    // A revoked grant with no recorded time says the time is unknown; a live one has no revocation time to show.
    if (shown === "revoked" || (row.revokedAt !== undefined && row.revokedAt !== null)) {
      list.append(kvRow("delegations.d.revokedat", dateText(row.revokedAt)));
    }
    if (row.revokedBy !== undefined) list.append(kvRow("delegations.d.revokedby", shortDid(row.revokedBy)));
    if (row.revokedAncestorCid !== undefined) list.append(kvRow("delegations.d.revokedvia", shortCid(row.revokedAncestorCid)));

    const heading = node("h4", "dl-sub-h", text("delegations.d.resources"));
    const resources = node("ul", "dl-res");
    for (const parsed of parseResources(row.resources)) {
      const item = node("li");
      item.append(node("code", undefined, parsed.path === "" ? text("delegations.ability.all") : parsed.path));
      const words = node("ul", "dl-chips");
      for (const verb of parsed.verbs) words.append(node("li", "dl-chip", text(`delegations.chip.${verb}`)));
      for (const raw of parsed.raws) words.append(node("li", "dl-chip", raw));
      if (words.childElementCount > 0) item.append(words);
      resources.append(item);
    }
    const unreadable = unreadableIn(row.resources);
    return [summary, list, heading, resources, ...(unreadable > 0 ? [node("p", "dl-fine", text("delegations.d.resources.unreadable"))] : [])];
  }

  function openDetails(card: Card): void {
    for (const other of cards.values()) {
      if (other === card) continue;
      other.drawer?.close();
      other.drawer = undefined;
      other.detail = undefined;
    }
    card.drawer?.close();
    const detail = node("div");
    card.detail = detail;
    detail.replaceChildren(...detailRows(card.row, shownStatus(card.row, Date.now()), Date.now()));
    const drawer = ctx.openDrawer({
      title: displayName(card.row),
      body: [detail],
      closeLabel: text("delegations.d.close"),
      anchor: card.article,
      onClose: () => {
        card.drawer = undefined;
        card.detail = undefined;
        if (!disposed) card.see.focus();
      },
    });
    drawer.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      drawer.close();
      card.drawer = undefined;
      card.detail = undefined;
      card.see.focus();
    });
    card.drawer = drawer;
  }

  // --- states -------------------------------------------------------------
  function destroy(card: Card): void {
    // Only the card's own entry: after a list change the same grant may already have a newer card.
    if (cards.get(card.cid) === card) cards.delete(card.cid);
    closeConfirm(card);
    card.drawer?.close();
    card.li.remove();
  }

  function iconNotice(className: string, heading: string, ...rest: Node[]): HTMLElement {
    const box = node("div", className);
    const mark = node("span", "dl-ic");
    mark.setAttribute("aria-hidden", "true");
    mark.append(icon("key"));
    box.append(mark, node("h4", undefined, heading), ...rest);
    return box;
  }

  function showNotice(content: Node | undefined): void {
    notice.replaceChildren(...(content === undefined ? [] : [content]));
    notice.hidden = content === undefined;
  }

  function askNotice(ability: PermissionAbility): HTMLElement {
    const client = ctx.client();
    const request = client?.requestAuthority;
    const canAsk = ability === "delegation/list" && typeof request === "function";
    const message = node(
      "p",
      undefined,
      text("delegations.ask.body") + (canAsk ? text("delegations.ask.openkey") : ""),
    );
    const parts: Node[] = [message];
    if (declined) parts.push(node("p", "dl-fine", text("delegations.ask.declined")));
    if (canAsk && request !== undefined) {
      const allow = actionButton(text("delegations.ask.button"));
      allow.addEventListener("click", () => {
        allow.disabled = true;
        const mine = epoch;
        void (async () => {
          let approved = false;
          try {
            approved = (await request(ability)).approved === true;
          } catch {
            approved = false;
          }
          // The ask was for the list that was on screen; if that list is gone, so is the answer.
          if (disposed || mine !== epoch) return;
          declined = !approved;
          if (approved) await settleList();
          if (disposed || mine !== epoch) return;
          if (approved) title.focus({ preventScroll: true });
          update();
        })();
      });
      parts.push(allow);
    }
    return iconNotice("dl-notice dl-notice-ask", text("delegations.ask.title", { app: appName() }), ...parts);
  }

  function emptyNotice(): HTMLElement {
    return iconNotice("dl-notice", text("delegations.empty.title"), node("p", undefined, text("delegations.empty.body")));
  }

  function errorNotice(): HTMLElement {
    const box = node("div", "dl-notice");
    const line = node("p", undefined, text("delegations.error"));
    line.setAttribute("role", "status");
    const retry = actionButton(text("view.retry"));
    retry.addEventListener("click", () => {
      // A read that was started for a list that has since been dropped does not get to end this one's loading state.
      const mine = ++retryId;
      reloading = true;
      update();
      void settleList().then(() => {
        if (mine !== retryId) return;
        reloading = false;
        update();
      });
    });
    box.append(line, retry);
    return box;
  }

  /** Where the next page starts: after the last page read here, else after the cache's first page. */
  function nextCursorOf(page: DelegationPage): string | undefined {
    return extraCursor === undefined ? page.nextCursor : extraCursor.next;
  }

  async function loadMore(): Promise<void> {
    const page = firstPage;
    const source = ctx.data.source;
    if (paging === "loading" || page === undefined || source === undefined) return;
    const cursor = nextCursorOf(page);
    if (cursor === undefined) return;
    const mine = epoch;
    paging = "loading";
    update();
    let result: ViewResult<DelegationPage>;
    try {
      result = await source.delegations(cursor);
    } catch {
      result = { state: "error", code: "thrown" };
    }
    if (disposed || mine !== epoch) return;
    if (result.state !== "ready") {
      paging = "error";
      update();
      showMore.focus({ preventScroll: true });
      return;
    }
    const known = new Set([...page.rows, ...extra].map((row) => row.cid));
    const fresh = result.data.rows.filter((row) => {
      if (known.has(row.cid)) return false;
      known.add(row.cid);
      return true;
    });
    extra = [...extra, ...fresh];
    extraCursor = { next: result.data.nextCursor };
    paging = "idle";
    live.textContent = text("delegations.more.loaded", { count: fresh.length });
    update();
    // The button stays where the user left focus while there is more; at the end it goes away, and focus goes to the first new card.
    if (result.data.nextCursor !== undefined) showMore.focus({ preventScroll: true });
    else (cards.get(fresh[0]?.cid ?? "")?.article ?? title).focus({ preventScroll: true });
  }

  function showList(page: DelegationPage): void {
    firstPage = page;
    const known = new Set(page.rows.map((row) => row.cid));
    const listed = [...page.rows, ...extra.filter((row) => !known.has(row.cid))];
    const rows = listed.filter((row) => !removed.has(row.cid));
    // With more pages the list is not the whole list: nothing listed yet is not "no one", and counts are lower bounds.
    const more = nextCursorOf(page) !== undefined;
    if (rows.length === 0 && !more) {
      for (const card of [...cards.values()]) if (card.phase !== "busy") destroy(card);
      showNotice(emptyNotice());
      body.hidden = true;
      return;
    }
    showNotice(undefined);
    body.hidden = false;

    const grouped = groupRows(rows);
    const seen = new Set<string>();
    const views: HTMLElement[] = [];
    for (const group of GROUPS) {
      const members = grouped[group];
      if (group === "received" && members.length === 0) continue;
      const view = groupView(group);
      // With more pages the group's true size is not known: "3+" is a lower bound and an empty group has no number.
      view.count.textContent = more ? (members.length === 0 ? "" : `${members.length}+`) : String(members.length);
      view.none.hidden = members.length > 0;
      view.none.textContent = text(more ? "delegations.g.none.more" : "delegations.g.none");
      const wanted: HTMLElement[] = [];
      for (const row of members) {
        let card = cards.get(row.cid);
        if (card === undefined) {
          card = buildCard(row);
          cards.set(row.cid, card);
        }
        card.row = row;
        seen.add(row.cid);
        if (card.confirm !== undefined && !canRevoke(row, Date.now())) {
          const box = card.confirm.cancel.closest("[role=alertdialog]");
          const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
          const hadFocus = box !== null && active !== null && box.contains(active);
          closeConfirm(card);
          card.phase = "stale";
          // The box held focus; without a move it would fall to the page.
          if (hadFocus) card.article.focus({ preventScroll: true });
        }
        paint(card);
        wanted.push(card.li);
      }
      wanted.forEach((li, at) => {
        if (view.list.children[at] !== li) view.list.insertBefore(li, view.list.children[at] ?? null);
      });
      views.push(view.section);
    }
    for (const card of [...cards.values()]) if (!seen.has(card.cid) && card.phase !== "busy") destroy(card);

    foot.hidden = !more;
    footNote.textContent = text("delegations.firstpage", { count: `${rows.length}+` });
    showMore.textContent = text(paging === "loading" ? "delegations.more.busy" : paging === "error" ? "view.retry" : "delegations.more.btn");
    showMore.setAttribute("aria-disabled", String(paging === "loading"));
    footErr.hidden = paging !== "error";
    footErr.textContent = text("delegations.more.err");
    // Placed in order without removing what is already in place, so focus inside a card survives a refresh.
    const wanted = [...views, foot];
    wanted.forEach((child, at) => {
      if (body.children[at] !== child) body.insertBefore(child, body.children[at] ?? null);
    });
    while (body.children.length > wanted.length) body.lastElementChild?.remove();
  }

  function update(): void {
    if (disposed) return;
    const source = ctx.data.source;
    const result = ctx.data.latest("delegations");
    // The list is dropped when it is no longer the one the pages were read for: the cache was cleared (account change,
    // sign-out), the data source changed, or a ready list stopped being ready. Everything keyed to that list goes with it
    // (pages read after the first, the paging state, a pending retry, an unanswered permission ask), and `epoch` moves on,
    // so a result still in flight for the old list is discarded when it arrives instead of landing in the new one.
    const dropped =
      started &&
      (source !== lastSource ||
        (result === undefined && lastResult !== undefined) ||
        (lastResult?.state === "ready" && result?.state !== "ready"));
    started = true;
    lastSource = source;
    lastResult = result;
    if (dropped) {
      epoch += 1;
      retryId += 1;
      reloading = false;
      declined = false;
      // The cards belong to the list that was dropped, a card whose revoke is still out included; a list that comes back
      // builds its own, and shows a grant with a request in flight as busy from the module's lock.
      for (const old of [...cards.values()]) destroy(old);
    }
    if (result === undefined || result.state !== "ready") {
      extra = [];
      extraCursor = undefined;
      paging = "idle";
    }
    // The freshness of what is listed, and the denied line, through the shared state-line helper. It is derived from the
    // result the cache holds now, so it can only describe the current account's list: after an account change the cache is
    // empty and the line is gone until that account's own read arrives.
    if (source !== undefined && (result?.state === "ready" || result?.state === "needs-permission")) {
      applyResult(fresh, ctx, result);
      if (result.state === "needs-permission") fresh.status.textContent = text("delegations.denied");
    } else {
      fresh.status.hidden = true;
      fresh.status.textContent = "";
    }
    skeleton.hidden = true;
    body.hidden = true;
    if (source === undefined) {
      showNotice(node("p", "note", text("delegations.unavailable")));
      return;
    }
    if (reloading || result === undefined || result.state === "loading") {
      showNotice(undefined);
      skeleton.hidden = false;
      return;
    }
    switch (result.state) {
      case "needs-permission":
        showNotice(askNotice(result.ability));
        return;
      case "error":
        showNotice(errorNotice());
        return;
      case "ready":
        showList(result.data);
    }
  }

  const unsubscribe = ctx.data.subscribe(update);
  update();
  // The shell reads on open; only a stale cache needs another read.
  const age = ctx.data.age("delegations");
  if (age !== undefined && age > 10_000) void settleList();

  return () => {
    disposed = true;
    unsubscribe();
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    for (const card of cards.values()) {
      closeConfirm(card);
      card.drawer?.close();
    }
    el.replaceChildren();
  };
}

/**
 * Delegations the account granted or received. Mounted only while the panel is
 * open and the session is signed in.
 */
export const delegationsSection: PanelSection = {
  id: "delegations",
  labelCode: "nav.delegations",
  icon: "key",
  summaryCode: "delegations.summary",
  isAvailable: (ctx) => ctx.client()?.signedIn() === true,
  // The rail shows how many rows the first page lists, less the ones revoked from this panel. With more pages the total is
  // not known: the number is a lower bound ("50+"), and with nothing listed yet there is no number at all.
  status: (ctx) =>
    viewStatus(ctx, ctx.data.latest("delegations"), (page) => {
      const gone = revokedFrom(ctx.data);
      const listed = page.rows.filter((row) => !gone.has(row.cid)).length;
      const more = page.nextCursor !== undefined;
      return {
        text: ctx.text("delegations.glance.visible"),
        tone: "ok",
        ...(more && listed === 0 ? {} : { count: `${listed}${more ? "+" : ""}` }),
      };
    }),
  mount: mountDelegations,
};
