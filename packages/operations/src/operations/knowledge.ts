import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { z } from "zod";

import { evaluateOperationAuthority } from "../authority.js";
import type {
  CapabilityRequirement,
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  RuntimeOperationContext,
  TinyCloudPosture,
} from "../contract.js";
import { operationError } from "../errors.js";
import { operationSpaceResolver } from "../secrets.js";
import {
  caughtKvFailure,
  kvFailure,
  projectAccountApplication,
  readAccountRegistry,
  resolveGenericKvSpace,
  runtimeContext,
} from "./exploration.js";
import { indexLinks, parseConcept, type YamlValue } from "./knowledge-concept.js";

/** The space every tiny app installs into (`<app_id>/app/` and `<app_id>/knowledge/`). */
export const KNOWLEDGE_SPACE = "applications";

const MAX_KNOWLEDGE_BYTES = 1024 * 1024;
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 10;

interface KnowledgeListInput {
  readonly app_id?: string;
}

interface KnowledgeApp {
  readonly app_id: string;
  readonly name?: string;
  /** Key prefix of the bundle, relative to the space. */
  readonly root: string;
  /** Whether `<root>index.md` exists in the space. */
  readonly has_index: boolean;
  /** Concept files under the root (relative paths, `.md` only, `index.md` excluded). */
  readonly concepts: readonly string[];
  /** Whether the account registry also lists this app. */
  readonly registered: boolean;
}

interface KnowledgeListOutput {
  readonly space: string;
  readonly apps: readonly KnowledgeApp[];
  readonly count: number;
  /** The space had more keys than one listing covers; some apps may be missing. */
  readonly truncated: boolean;
  /**
   * `merged`: the account registry was read and merged. `not_granted`: the
   * session cannot read it. `unavailable`: it could not be read. `skipped`:
   * a single app was requested.
   */
  readonly registry: "merged" | "not_granted" | "unavailable" | "skipped";
}

interface KnowledgeReadInput {
  readonly app_id: string;
  readonly concept?: string;
}

interface KnowledgeReadOutput {
  readonly app_id: string;
  readonly space: string;
  /** Path relative to the bundle root, `index.md` for the index. */
  readonly path: string;
  readonly key: string;
  readonly kind: "index" | "concept";
  readonly frontmatter: { readonly [key: string]: YamlValue } | null;
  readonly frontmatter_error?: string;
  readonly frontmatter_raw?: string;
  readonly body: string;
  /** Local links of an index file; empty for concepts. */
  readonly links: readonly { readonly title: string; readonly target: string }[];
  readonly byteLength: number;
  readonly etag?: string;
}

type KnowledgeKvResult<T> =
  | Readonly<{ ok: true; data: T }>
  | Readonly<{ ok: false; error: Readonly<{ code?: string; meta?: Readonly<Record<string, unknown>> }> }>;

interface KnowledgeKvHandle {
  list(options: Readonly<{ prefix?: string; limit: number; cursor?: string }>): Promise<KnowledgeKvResult<{
    readonly keys: readonly string[];
    readonly truncated?: boolean;
    readonly nextCursor?: string;
  }>>;
  get(key: string, options: Readonly<{ binary: true; maxResponseBytes: number }>): Promise<KnowledgeKvResult<{
    readonly data: Uint8Array;
    readonly headers: Readonly<{ etag?: string }>;
  }>>;
}

const AppIdSchema = z.string().min(1).max(200).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "Invalid app id.",
);
const ConceptSchema = z.string().min(1).max(300).refine(
  (concept) =>
    !concept.startsWith("/") &&
    !concept.includes("*") &&
    !concept.includes("\\") &&
    concept.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "Invalid concept path.",
);

const KnowledgeListInputSchema: z.ZodType<KnowledgeListInput> = z.object({
  app_id: AppIdSchema.optional(),
}).strict();
const KnowledgeAppSchema: z.ZodType<KnowledgeApp> = z.object({
  app_id: z.string().min(1),
  name: z.string().optional(),
  root: z.string().min(1),
  has_index: z.boolean(),
  concepts: z.array(z.string()),
  registered: z.boolean(),
}).strict();
const KnowledgeListOutputSchema: z.ZodType<KnowledgeListOutput> = z.object({
  space: z.string().min(1),
  apps: z.array(KnowledgeAppSchema),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  registry: z.enum(["merged", "not_granted", "unavailable", "skipped"]),
}).strict();

const YamlValueSchema: z.ZodType<YamlValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(YamlValueSchema),
  z.record(YamlValueSchema),
]));
const KnowledgeReadInputSchema: z.ZodType<KnowledgeReadInput> = z.object({
  app_id: AppIdSchema,
  concept: ConceptSchema.optional(),
}).strict();
const KnowledgeReadOutputSchema: z.ZodType<KnowledgeReadOutput> = z.object({
  app_id: z.string().min(1),
  space: z.string().min(1),
  path: z.string().min(1),
  key: z.string().min(1),
  kind: z.enum(["index", "concept"]),
  frontmatter: z.record(YamlValueSchema).nullable(),
  frontmatter_error: z.string().optional(),
  frontmatter_raw: z.string().optional(),
  body: z.string(),
  links: z.array(z.object({ title: z.string(), target: z.string() }).strict()),
  byteLength: z.number().int().nonnegative(),
  etag: z.string().optional(),
}).strict();

const AUTHENTICATED_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];
const KNOWLEDGE_EXPOSURE: OperationExposure = {
  cli: { status: "required" },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};
const KNOWLEDGE_LIST_SENSITIVITY: OperationSensitivity = { input: [], output: ["/apps"] };
const KNOWLEDGE_READ_SENSITIVITY: OperationSensitivity = {
  input: ["/app_id", "/concept"],
  output: ["/body", "/frontmatter", "/frontmatter_raw", "/links"],
};

export const knowledgeOperationDefinitions: readonly [
  OperationDefinition<KnowledgeListInput, KnowledgeListOutput>,
  OperationDefinition<KnowledgeReadInput, KnowledgeReadOutput>,
] = [
  {
    id: "tinycloud.knowledge.list",
    version: 1,
    title: "List installed apps' knowledge bundles",
    description:
      "List the apps whose knowledge bundle (`<app_id>/knowledge/index.md`) is in the user's `applications` space, with each bundle's concept files. Merges the account application registry when the session can read it. Pass app_id to inspect one app with a grant scoped to that app.",
    input: KnowledgeListInputSchema,
    output: KnowledgeListOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: KNOWLEDGE_EXPOSURE,
    sensitivity: KNOWLEDGE_LIST_SENSITIVITY,
    authority: planKnowledgeList,
    execute: executeKnowledgeList,
  },
  {
    id: "tinycloud.knowledge.read",
    version: 1,
    title: "Read an app's knowledge index or concept",
    description:
      "Read `<app_id>/knowledge/index.md`, or one concept file of the bundle, with its frontmatter parsed. Concepts name the KV prefixes and SQL tables an app uses (`resource:`); read the index first, then open only the concepts you need.",
    input: KnowledgeReadInputSchema,
    output: KnowledgeReadOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: KNOWLEDGE_EXPOSURE,
    sensitivity: KNOWLEDGE_READ_SENSITIVITY,
    authority: planKnowledgeRead,
    execute: executeKnowledgeRead,
  },
];

async function planKnowledgeList(
  context: RuntimeOperationContext,
  input: KnowledgeListInput,
): Promise<readonly CapabilityRequirement[]> {
  return [{
    service: "tinycloud.kv",
    space: resolveGenericKvSpace(context, KNOWLEDGE_SPACE),
    path: input.app_id === undefined ? "" : `${input.app_id}/knowledge/`,
    actions: ["tinycloud.kv/list"],
  }];
}

async function planKnowledgeRead(
  context: RuntimeOperationContext,
  input: KnowledgeReadInput,
): Promise<readonly CapabilityRequirement[]> {
  return [{
    service: "tinycloud.kv",
    space: resolveGenericKvSpace(context, KNOWLEDGE_SPACE),
    path: knowledgeKey(input.app_id, conceptPath(input.concept)),
    actions: ["tinycloud.kv/get"],
  }];
}

/** `index.md` when no concept is named; a bare concept name gets its `.md` extension. */
function conceptPath(concept: string | undefined): string {
  if (concept === undefined) return "index.md";
  return concept.endsWith(".md") ? concept : `${concept}.md`;
}

function knowledgeKey(appId: string, path: string): string {
  return `${appId}/knowledge/${path}`;
}

function knowledgeKv(context: RuntimeOperationContext, space: string): KnowledgeKvHandle {
  return (context.runtime.node as TinyCloudNode).kvForSpace(space) as unknown as KnowledgeKvHandle;
}

async function executeKnowledgeList(
  context: OperationContext,
  input: KnowledgeListInput,
): Promise<OperationExecutionOutcome<KnowledgeListOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveGenericKvSpace(runtime, KNOWLEDGE_SPACE);
    const kv = knowledgeKv(runtime, space);
    const prefix = input.app_id === undefined ? "" : `${input.app_id}/knowledge/`;

    const keys: string[] = [];
    let truncated = false;
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      const listed = await kv.list({
        ...(prefix === "" ? {} : { prefix }),
        limit: LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!listed.ok) return kvFailure(listed.error, "list the applications space");
      keys.push(...listed.data.keys);
      if (listed.data.truncated !== true) break;
      cursor = listed.data.nextCursor;
      if (cursor === undefined || page + 1 >= MAX_LIST_PAGES) {
        truncated = true;
        break;
      }
    }

    const bundles = groupBundles(keys);
    const registry = await readRegistry(runtime, input.app_id);
    const apps = new Map<string, KnowledgeApp>();
    for (const [appId, bundle] of bundles) {
      if (!bundle.hasIndex) continue;
      apps.set(appId, {
        app_id: appId,
        ...(registry.names.get(appId) === undefined ? {} : { name: registry.names.get(appId) }),
        root: `${appId}/knowledge/`,
        has_index: true,
        concepts: [...bundle.concepts].sort(),
        registered: registry.names.has(appId),
      });
    }
    for (const [appId, name] of registry.names) {
      if (apps.has(appId) || (input.app_id !== undefined && appId !== input.app_id)) continue;
      apps.set(appId, {
        app_id: appId,
        ...(name === undefined ? {} : { name }),
        root: `${appId}/knowledge/`,
        has_index: false,
        concepts: [],
        registered: true,
      });
    }
    const sorted = [...apps.values()].sort((left, right) => left.app_id.localeCompare(right.app_id));
    return {
      status: "ok",
      output: { space, apps: sorted, count: sorted.length, truncated, registry: registry.status },
    };
  } catch (error) {
    return caughtKvFailure(error, "list the applications space");
  }
}

interface Bundle {
  hasIndex: boolean;
  readonly concepts: string[];
}

/** Group `<app_id>/knowledge/<path>` keys by app. Other keys (`<app_id>/app/…`, data) are not bundles. */
function groupBundles(keys: readonly string[]): Map<string, Bundle> {
  const bundles = new Map<string, Bundle>();
  for (const key of keys) {
    const match = /^([^/]+)\/knowledge\/(.+\.md)$/.exec(key);
    if (match === null) continue;
    const [, appId, path] = match as unknown as [string, string, string];
    const bundle = bundles.get(appId) ?? { hasIndex: false, concepts: [] };
    if (path === "index.md") bundle.hasIndex = true;
    else bundle.concepts.push(path);
    bundles.set(appId, bundle);
  }
  return bundles;
}

const REGISTRY_REQUIREMENT: readonly CapabilityRequirement[] = [{
  service: "tinycloud.kv",
  space: "account",
  path: "applications/",
  actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
}];

/** Registry apps by id, read only when the session already holds the account registry grant. */
async function readRegistry(
  context: RuntimeOperationContext,
  appId: string | undefined,
): Promise<{ status: KnowledgeListOutput["registry"]; names: Map<string, string | undefined> }> {
  const names = new Map<string, string | undefined>();
  if (appId !== undefined) return { status: "skipped", names };
  const resolver = operationSpaceResolver(context.runtime.node, context.summary.space);
  const granted = evaluateOperationAuthority(
    context.runtime.granted as unknown as PermissionEntry[],
    REGISTRY_REQUIREMENT as unknown as PermissionEntry[],
    resolver,
  ).satisfied;
  if (!granted) return { status: "not_granted", names };
  try {
    const registry = await readAccountRegistry(context, "applications/");
    if (!registry.ok) return { status: "unavailable", names };
    for (const { key, value } of registry.records) {
      const application = projectAccountApplication(key, value);
      names.set(application.appId, application.name);
    }
    return { status: "merged", names };
  } catch {
    return { status: "unavailable", names: new Map() };
  }
}

async function executeKnowledgeRead(
  context: OperationContext,
  input: KnowledgeReadInput,
): Promise<OperationExecutionOutcome<KnowledgeReadOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveGenericKvSpace(runtime, KNOWLEDGE_SPACE);
    const path = conceptPath(input.concept);
    const key = knowledgeKey(input.app_id, path);
    const result = await knowledgeKv(runtime, space).get(key, {
      binary: true,
      maxResponseBytes: MAX_KNOWLEDGE_BYTES,
    });
    if (!result.ok) return kvFailure(result.error, "read the knowledge file");
    const bytes = result.data.data;
    if (bytes.byteLength > MAX_KNOWLEDGE_BYTES) {
      return kvFailure({ code: "KV_RESPONSE_TOO_LARGE" }, "read the knowledge file");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        status: "error",
        error: operationError("OUTPUT_INVALID", "The knowledge file is not valid UTF-8."),
      };
    }
    const concept = parseConcept(text);
    const isIndex = input.concept === undefined;
    return {
      status: "ok",
      output: {
        app_id: input.app_id,
        space,
        path,
        key,
        kind: isIndex ? "index" : "concept",
        frontmatter: concept.frontmatter,
        ...(concept.frontmatterError === undefined ? {} : { frontmatter_error: concept.frontmatterError }),
        ...(concept.frontmatterRaw === undefined ? {} : { frontmatter_raw: concept.frontmatterRaw }),
        body: concept.body,
        links: isIndex ? indexLinks(concept.body) : [],
        byteLength: bytes.byteLength,
        ...(result.data.headers.etag === undefined ? {} : { etag: result.data.headers.etag }),
      },
    };
  } catch (error) {
    return caughtKvFailure(error, "read the knowledge file");
  }
}
