/**
 * The tc-apps per-app layout, as the bundled skill (`skills/tc-apps/SKILL.md`
 * §2, §4a, §6) and the /apps setup guide write it. `apps init` and
 * `setup apps --app` read these definitions; `tiny-apps.test.ts` checks them
 * against the bundled SKILL.md, so the CLI and the skill cannot drift apart.
 *
 * - App `<APP>` lives under `xyz.tinycloud.tinyapps.<APP>/` in the owner's
 *   `applications` space, with its own profile `tinyapp-<APP>` and approval.
 * - Its discovery entry is `xyz.tinycloud.tinyapps.catalog/<APP>/entry`, the
 *   one key outside that folder the app's approval may write.
 */

/** Space every tiny app keeps its records in. */
export const TINY_APPS_SPACE = "applications";
/** Key root of the discovery entries. */
export const TINY_APPS_CATALOG = "xyz.tinycloud.tinyapps.catalog";
/** Approval lifetime the skill requests for each app (§4a). */
export const TINY_APP_LOGIN_EXPIRY = "30d";

const APP_NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** Names the skill reserves (§2): the catalog, the index marker and the catalog apps. */
const RESERVED_APP_NAMES: Readonly<Record<string, true>> = { catalog: true, "index-stale": true, healthlog: true, recipes: true };
const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,62}$/;
/** A client name as a record's `by` carries it: `claude-code`, `codex`, `opencode`, … */
const CLIENT = /^[a-z][a-z0-9-]{0,39}$/;
const SLUG_MAX = 60;

export class TinyAppInputError extends Error {
  constructor(readonly code: "INVALID_APP" | "INVALID_TITLE" | "INVALID_CLIENT" | "INVALID_STARTER" | "UNKNOWN_TEMPLATE", message: string) {
    super(message);
    this.name = "TinyAppInputError";
  }
}

export function assertTinyAppName(app: string): string {
  if (!APP_NAME.test(app)) {
    throw new TinyAppInputError("INVALID_APP", `Invalid app name "${app.slice(0, 80)}": lowercase a-z, 0-9 and -, starting with a letter.`);
  }
  if (Object.hasOwn(RESERVED_APP_NAMES, app)) {
    throw new TinyAppInputError("INVALID_APP", `"${app}" is reserved (catalog, index-stale, healthlog, recipes).`);
  }
  return app;
}

export function assertTinyAppTitle(title: string): string {
  if (!TITLE.test(title)) throw new TinyAppInputError("INVALID_TITLE", "An app title is letters, digits and spaces only.");
  return title;
}

export function assertClient(client: string): string {
  if (!CLIENT.test(client)) {
    throw new TinyAppInputError("INVALID_CLIENT", `Invalid client "${client.slice(0, 80)}": use claude-code, codex or opencode.`);
  }
  return client;
}

/** `xyz.tinycloud.tinyapps.<APP>`: the app's key root and app id. */
export function tinyAppId(app: string): string {
  return `xyz.tinycloud.tinyapps.${assertTinyAppName(app)}`;
}

/** The app's own CLI profile. */
export function tinyAppProfile(app: string): string {
  return `tinyapp-${assertTinyAppName(app)}`;
}

/** The state-folder file the skill writes the app's request to (§4a). */
export function tinyAppManifestFile(app: string): string {
  return `${tinyAppProfile(app)}.json`;
}

/**
 * The app's sign-in request, exactly as SKILL.md §4a writes it: the app's own
 * folder, read access to the discovery entries, and put on the app's own entry.
 */
export function tinyAppManifest(app: string, title: string): Record<string, unknown> {
  const id = tinyAppId(app);
  return {
    manifest_version: 1,
    app_id: id,
    name: `${assertTinyAppTitle(title)} (tiny app)`,
    space: TINY_APPS_SPACE,
    defaults: false,
    permissions: [
      { service: "tinycloud.kv", path: `${id}/`, skipPrefix: true, actions: ["get", "put", "list", "del"] },
      { service: "tinycloud.kv", path: `${TINY_APPS_CATALOG}/`, skipPrefix: true, actions: ["get", "list"] },
      { service: "tinycloud.kv", path: `${TINY_APPS_CATALOG}/${app}/`, skipPrefix: true, actions: ["put"] },
    ],
  };
}

interface KindTemplate {
  readonly kind: string;
  readonly about: string;
  readonly shape: "item";
  /** New items start in the first state. */
  readonly states: readonly [string, ...string[]];
  readonly v: number;
  readonly fields: Readonly<Record<string, string>>;
  /** The field a starter record's text goes in. */
  readonly starterField: string;
}

interface AppTemplate {
  readonly title: string;
  readonly about: string;
  readonly kind: KindTemplate;
}

/**
 * Apps `apps init` can create. `todos` is the setup guide's default app; its
 * records are the ones the /apps guide documents for a setup-only request.
 */
const TEMPLATES: Readonly<Record<string, AppTemplate>> = {
  todos: {
    title: "Todos",
    about: "Things to do.",
    kind: {
      kind: "todo",
      about: "One record per thing to do.",
      shape: "item",
      states: ["open", "done"],
      v: 1,
      fields: { title: "text: what to do" },
      starterField: "title",
    },
  },
};

export function tinyAppTemplate(app: string): AppTemplate {
  assertTinyAppName(app);
  if (!Object.hasOwn(TEMPLATES, app)) {
    throw new TinyAppInputError("UNKNOWN_TEMPLATE", `No template for "${app}". Available: ${Object.keys(TEMPLATES).join(", ")}.`);
  }
  return TEMPLATES[app]!;
}

/** Title for `setup apps --app`: the template's, or the one given. */
export function tinyAppTitle(app: string, title?: string): string {
  if (title !== undefined) return assertTinyAppTitle(title);
  if (Object.hasOwn(TEMPLATES, app)) return TEMPLATES[app]!.title;
  throw new TinyAppInputError("INVALID_TITLE", `--title is required for "${app}": letters, digits and spaces.`);
}

/** A key slug: lowercase `a-z`, `0-9` and `-` (skill §2). "Try my personal apps" → `try-my-personal-apps`. */
export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/, "");
  if (slug === "") throw new TinyAppInputError("INVALID_STARTER", "The starter text needs at least one letter or digit.");
  return slug;
}

/** `2026-10-06T16:30:12Z`, as `date -u +%FT%TZ` prints it. */
export function utcStamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** This computer's local date, `YYYY-MM-DD`. */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export type TinyAppKeyRole = "app" | "kind" | "entry" | "starter";

export interface PlannedRecord {
  readonly role: TinyAppKeyRole;
  readonly key: string;
  readonly value: Record<string, unknown>;
}

export interface TinyAppPlan {
  readonly app: string;
  readonly id: string;
  /** Catalog first, then the discovery entry, then the starter (skill §2 rule 2). */
  readonly records: readonly PlannedRecord[];
  /** The starter's twin keys in the kind's other states: any of them existing means the starter is skipped. */
  readonly starterTwins: readonly string[];
}

/** The records `apps init` writes, in write order, with the skill's shapes. */
export function planTinyAppInit(params: { app: string; by: string; starter?: string; now: Date }): TinyAppPlan {
  const template = tinyAppTemplate(params.app);
  const by = assertClient(params.by);
  const id = tinyAppId(params.app);
  const { kind } = template;
  const records: PlannedRecord[] = [
    {
      role: "app",
      key: `${id}/catalog`,
      value: { app: params.app, title: template.title, about: template.about, created: localDate(params.now), by },
    },
    {
      role: "kind",
      key: `${id}/catalog/${kind.kind}`,
      value: { app: params.app, kind: kind.kind, about: kind.about, shape: kind.shape, states: [...kind.states], v: kind.v, fields: { ...kind.fields } },
    },
    {
      role: "entry",
      key: `${TINY_APPS_CATALOG}/${params.app}/entry`,
      value: { v: 1, app: params.app, id, title: template.title },
    },
  ];
  let starterTwins: string[] = [];
  if (params.starter !== undefined) {
    const text = params.starter.trim();
    if (text === "" || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new TinyAppInputError("INVALID_STARTER", "The starter text is one line of at most 200 characters.");
    }
    // A fixed id (the slug alone, no date) keeps the starter unique across reruns (skill §2, Ids).
    const slug = slugify(text);
    const [first, ...others] = kind.states;
    records.push({
      role: "starter",
      key: `${id}/${kind.kind}/${first}/${slug}`,
      value: { v: kind.v, at: utcStamp(params.now), data: { [kind.starterField]: text }, by },
    });
    starterTwins = others.map((state) => `${id}/${kind.kind}/${state}/${slug}`);
  }
  return { app: params.app, id, records, starterTwins };
}

/** KV access `initTinyApp` needs, bound to the profile's `applications` space. */
export interface TinyAppKvPort {
  /** The parsed record, or `undefined` when the key does not exist. */
  get(key: string): Promise<unknown | undefined>;
  /** Create-only write (`If-None-Match: *`). `"exists"` when the key was already there. */
  create(key: string, bytes: Uint8Array): Promise<"created" | "exists">;
}

export interface InitKeyResult {
  readonly role: TinyAppKeyRole;
  readonly key: string;
  /** `created`: written now. `exists`: already there, left as it is. `skipped`: the starter's twin exists (it is already done). */
  readonly status: "created" | "exists" | "skipped";
  /** The record as read back after the writes. */
  readonly record?: unknown;
  /** For a skipped starter: the twin that exists. */
  readonly existingTwin?: string;
}

export interface InitResult {
  readonly app: string;
  readonly id: string;
  readonly keys: readonly InitKeyResult[];
}

/** One record as `kv put --stdin` stores it from the skill's heredoc: the JSON line and a newline. */
export function recordBytes(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/**
 * Create the app's catalog records, its discovery entry and the starter
 * record. Every write is create-only: an existing record is never changed.
 * The starter is skipped when it, or its twin in another state, exists, so a
 * todo the owner already ticked off is not saved again.
 */
export async function initTinyApp(plan: TinyAppPlan, kv: TinyAppKvPort): Promise<InitResult> {
  const starter = plan.records.find((record) => record.role === "starter");
  const twins = starter === undefined ? [] : await Promise.all(plan.starterTwins.map(async (key) => ({ key, value: await kv.get(key) })));
  const existingTwin = twins.find((twin) => twin.value !== undefined)?.key;

  const outcomes: Array<{ record: PlannedRecord; status: InitKeyResult["status"] }> = [];
  for (const record of plan.records) {
    if (record.role === "starter" && existingTwin !== undefined) {
      outcomes.push({ record, status: "skipped" });
      continue;
    }
    // In order: the catalog exists before the first record that uses it.
    outcomes.push({ record, status: await kv.create(record.key, recordBytes(record.value)) });
  }
  const readBack = await Promise.all(outcomes.map(({ record, status }) =>
    status === "skipped" ? Promise.resolve(undefined) : kv.get(record.key)));
  return {
    app: plan.app,
    id: plan.id,
    keys: outcomes.map(({ record, status }, index) => ({
      role: record.role,
      key: record.key,
      status,
      ...(status === "skipped" ? { existingTwin } : { record: readBack[index] }),
    })),
  };
}
