import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { z } from "zod";

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
import { OperationInvocationError, operationError } from "../errors.js";
import { operationSpaceResolver } from "../secrets.js";

type EmptyInput = Record<never, never>;

interface AccountSpacesOutput {
  readonly spaces: readonly {
    readonly spaceId: string;
    readonly name: string;
    readonly ownerDid: string;
    readonly type: "owned" | "delegated" | "discovered";
    readonly permissions: readonly string[];
    readonly status: "active" | "archived";
    readonly registeredAt?: string;
    readonly updatedAt?: string;
    readonly expiresAt?: string;
  }[];
  readonly count: number;
}

interface AccountApplicationsOutput {
  readonly applications: readonly {
    readonly appId: string;
    readonly manifests: readonly Record<string, unknown>[];
    readonly updatedAt?: string;
    readonly name?: string;
    readonly description?: string;
    readonly manifestHash?: string;
  }[];
  readonly count: number;
}

interface KvListInput {
  readonly space: string;
  readonly prefix?: string;
}

interface KvListOutput {
  readonly space: string;
  readonly prefix: string;
  readonly keys: readonly string[];
  readonly count: number;
}

interface KvGetInput {
  readonly space: string;
  readonly key: string;
}

interface KvGetOutput {
  readonly space: string;
  readonly key: string;
  readonly value: unknown;
  readonly encoding: "json" | "text" | "base64";
  readonly metadata: {
    readonly etag?: string;
    readonly contentType?: string;
    readonly lastModified?: string;
    readonly contentLength?: number;
  };
}

const EmptyInputSchema: z.ZodType<EmptyInput> = z.object({}).strict();
const SpaceSchema = z.string().min(1).refine(
  (space) =>
    (/^[A-Za-z0-9_-]+$/.test(space) || space.startsWith("tinycloud:")) &&
    !space.includes("*"),
  "Invalid TinyCloud space.",
);
const PrefixSchema = z.string().refine(
  (prefix) => prefix !== "/" && !prefix.includes("*"),
  "Invalid KV prefix.",
);
const KeySchema = z.string().min(1).refine(
  (key) => key !== "/" && !key.endsWith("/") && !key.includes("*"),
  "Invalid KV key.",
);

const AccountSpaceSchema = z.object({
  spaceId: z.string().min(1),
  name: z.string().min(1),
  ownerDid: z.string(),
  type: z.enum(["owned", "delegated", "discovered"]),
  permissions: z.array(z.string()),
  status: z.enum(["active", "archived"]),
  registeredAt: z.string().optional(),
  updatedAt: z.string().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const AccountSpacesOutputSchema: z.ZodType<AccountSpacesOutput> = z.object({
  spaces: z.array(AccountSpaceSchema),
  count: z.number().int().nonnegative(),
}).strict();

const AccountApplicationSchema = z.object({
  appId: z.string().min(1),
  manifests: z.array(z.record(z.unknown())),
  updatedAt: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  manifestHash: z.string().optional(),
}).strict();
const AccountApplicationsOutputSchema: z.ZodType<AccountApplicationsOutput> = z.object({
  applications: z.array(AccountApplicationSchema),
  count: z.number().int().nonnegative(),
}).strict();

const KvListInputSchema: z.ZodType<KvListInput> = z.object({
  space: SpaceSchema,
  prefix: PrefixSchema.optional(),
}).strict();
const KvListOutputSchema: z.ZodType<KvListOutput> = z.object({
  space: z.string().min(1),
  prefix: z.string(),
  keys: z.array(z.string()),
  count: z.number().int().nonnegative(),
}).strict();

const KvGetInputSchema: z.ZodType<KvGetInput> = z.object({
  space: SpaceSchema,
  key: KeySchema,
}).strict();
const KvGetOutputSchema: z.ZodType<KvGetOutput> = z.object({
  space: z.string().min(1),
  key: z.string().min(1),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.unknown()),
  ]),
  encoding: z.enum(["json", "text", "base64"]),
  metadata: z.object({
    etag: z.string().optional(),
    contentType: z.string().optional(),
    lastModified: z.string().optional(),
    contentLength: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

const AUTHENTICATED_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];
const EXPLORATION_EXPOSURE: OperationExposure = {
  cli: {
    status: "excluded",
    reason: "Existing account and KV Commander commands remain the CLI surface.",
  },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};

const ACCOUNT_SPACES_SENSITIVITY: OperationSensitivity = {
  input: [],
  output: ["/spaces"],
};
const ACCOUNT_APPLICATIONS_SENSITIVITY: OperationSensitivity = {
  input: [],
  output: ["/applications"],
};
const KV_LIST_SENSITIVITY: OperationSensitivity = {
  input: ["/prefix"],
  output: ["/keys"],
};
const KV_GET_SENSITIVITY: OperationSensitivity = {
  input: ["/key"],
  output: ["/value"],
};

type ExplorationDefinition =
  | OperationDefinition<EmptyInput, AccountSpacesOutput>
  | OperationDefinition<EmptyInput, AccountApplicationsOutput>
  | OperationDefinition<KvListInput, KvListOutput>
  | OperationDefinition<KvGetInput, KvGetOutput>;

export const explorationOperationDefinitions: readonly ExplorationDefinition[] = [
  {
    id: "tinycloud.account.spaces.list",
    version: 1,
    title: "List TinyCloud account spaces",
    description: "List the spaces registered in the selected owner's TinyCloud account.",
    input: EmptyInputSchema,
    output: AccountSpacesOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: EXPLORATION_EXPOSURE,
    sensitivity: ACCOUNT_SPACES_SENSITIVITY,
    authority: (context: RuntimeOperationContext) => planAccountRegistryRead(context, "spaces/"),
    execute: executeAccountSpacesList,
  },
  {
    id: "tinycloud.account.applications.list",
    version: 1,
    title: "List TinyCloud account applications",
    description: "List the application manifests registered in the selected owner's TinyCloud account.",
    input: EmptyInputSchema,
    output: AccountApplicationsOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: EXPLORATION_EXPOSURE,
    sensitivity: ACCOUNT_APPLICATIONS_SENSITIVITY,
    authority: (context: RuntimeOperationContext) => planAccountRegistryRead(context, "applications/"),
    execute: executeAccountApplicationsList,
  },
  {
    id: "tinycloud.kv.list",
    version: 1,
    title: "List TinyCloud KV keys",
    description: "List keys at one exact prefix in a delegated TinyCloud space.",
    input: KvListInputSchema,
    output: KvListOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: EXPLORATION_EXPOSURE,
    sensitivity: KV_LIST_SENSITIVITY,
    authority: planKvList,
    execute: executeKvList,
  },
  {
    id: "tinycloud.kv.get",
    version: 1,
    title: "Get a TinyCloud KV value",
    description: "Read one exact key from a delegated non-secrets TinyCloud space.",
    input: KvGetInputSchema,
    output: KvGetOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: EXPLORATION_EXPOSURE,
    sensitivity: KV_GET_SENSITIVITY,
    authority: planKvGet,
    execute: executeKvGet,
  },
];

async function planAccountRegistryRead(
  context: RuntimeOperationContext,
  path: "spaces/" | "applications/",
): Promise<readonly CapabilityRequirement[]> {
  return [{
    service: "tinycloud.kv",
    space: resolveSpace(context, "account"),
    path,
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  }];
}

async function planKvList(
  context: RuntimeOperationContext,
  input: KvListInput,
): Promise<readonly CapabilityRequirement[]> {
  const space = resolveNonSecretSpace(context, input.space);
  return [{
    service: "tinycloud.kv",
    space,
    path: input.prefix ?? "",
    actions: ["tinycloud.kv/list"],
  }];
}

async function planKvGet(
  context: RuntimeOperationContext,
  input: KvGetInput,
): Promise<readonly CapabilityRequirement[]> {
  const space = resolveNonSecretSpace(context, input.space);
  return [{
    service: "tinycloud.kv",
    space,
    path: input.key,
    actions: ["tinycloud.kv/get"],
  }];
}

async function executeAccountSpacesList(
  context: OperationContext,
  _input: EmptyInput,
): Promise<OperationExecutionOutcome<AccountSpacesOutput>> {
  try {
    const entries = await readAccountRegistry(context, "spaces/");
    if (!entries.ok) return nodeFailure("list account spaces");
    const spaces = entries.records
      .map(({ key, value }) => projectAccountSpace(key, value))
      .sort((left, right) => left.name.localeCompare(right.name) || left.spaceId.localeCompare(right.spaceId));
    return { status: "ok", output: { spaces, count: spaces.length } };
  } catch {
    return nodeFailure("list account spaces");
  }
}

async function executeAccountApplicationsList(
  context: OperationContext,
  _input: EmptyInput,
): Promise<OperationExecutionOutcome<AccountApplicationsOutput>> {
  try {
    const entries = await readAccountRegistry(context, "applications/");
    if (!entries.ok) return nodeFailure("list account applications");
    const applications = entries.records
      .map(({ key, value }) => projectAccountApplication(key, value))
      .sort((left, right) => left.appId.localeCompare(right.appId));
    return { status: "ok", output: { applications, count: applications.length } };
  } catch {
    return nodeFailure("list account applications");
  }
}

async function executeKvList(
  context: OperationContext,
  input: KvListInput,
): Promise<OperationExecutionOutcome<KvListOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveNonSecretSpace(runtime, input.space);
    const result = await runtimeNode(runtime).kvForSpace(space).list(
      input.prefix === undefined ? undefined : { prefix: input.prefix },
    );
    if (!result.ok) return nodeFailure("list KV keys");
    const keys = [...result.data.keys];
    return {
      status: "ok",
      output: { space, prefix: input.prefix ?? "", keys, count: keys.length },
    };
  } catch (error) {
    if (error instanceof OperationInvocationError) {
      return { status: "error", error: error.operationError };
    }
    return nodeFailure("list KV keys");
  }
}

async function executeKvGet(
  context: OperationContext,
  input: KvGetInput,
): Promise<OperationExecutionOutcome<KvGetOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveNonSecretSpace(runtime, input.space);
    const result = await runtimeNode(runtime).kvForSpace(space).get(input.key);
    if (!result.ok) return nodeFailure("read the KV value");
    const encoded = encodeKvValue(result.data.data);
    return {
      status: "ok",
      output: {
        space,
        key: input.key,
        value: encoded.value,
        encoding: encoded.encoding,
        metadata: {
          ...(result.data.headers.etag === undefined ? {} : { etag: result.data.headers.etag }),
          ...(result.data.headers.contentType === undefined
            ? {}
            : { contentType: result.data.headers.contentType }),
          ...(result.data.headers.lastModified === undefined
            ? {}
            : { lastModified: result.data.headers.lastModified }),
          ...(result.data.headers.contentLength === undefined
            ? {}
            : { contentLength: result.data.headers.contentLength }),
        },
      },
    };
  } catch (error) {
    if (error instanceof OperationInvocationError) {
      return { status: "error", error: error.operationError };
    }
    return nodeFailure("read the KV value");
  }
}

function runtimeContext(context: OperationContext): RuntimeOperationContext {
  if (context.runtime === undefined) {
    throw new TypeError("Authenticated operation runtime is unavailable.");
  }
  return context as RuntimeOperationContext;
}

function runtimeNode(context: OperationContext): TinyCloudNode {
  return runtimeContext(context).runtime.node as TinyCloudNode;
}

function resolveSpace(context: RuntimeOperationContext, space: string): string {
  return operationSpaceResolver(context.runtime.node, context.summary.space)(space);
}

function resolveNonSecretSpace(context: RuntimeOperationContext, space: string): string {
  const resolved = resolveSpace(context, space);
  if (resolved.split(":").at(-1)?.toLowerCase() === "secrets") {
    throw new OperationInvocationError(operationError(
      "INPUT_INVALID",
      "Generic KV operations cannot access the TinyCloud secrets space; use tinycloud.secrets.get.",
    ));
  }
  return resolved;
}

async function readAccountRegistry(
  context: OperationContext,
  prefix: "spaces/" | "applications/",
): Promise<
  | Readonly<{ ok: true; records: readonly Readonly<{ key: string; value: Record<string, unknown> }>[] }>
  | Readonly<{ ok: false }>
> {
  const runtime = runtimeContext(context);
  const accountSpace = resolveSpace(runtime, "account");
  const kv = runtimeNode(runtime).kvForSpace(accountSpace);
  const listed = await kv.list({ prefix });
  if (!listed.ok) return { ok: false };

  const records: Array<Readonly<{ key: string; value: Record<string, unknown> }>> = [];
  for (const key of listed.data.keys) {
    const loaded = await kv.get<unknown>(key);
    if (!loaded.ok || !isRecord(loaded.data.data)) return { ok: false };
    records.push({ key, value: loaded.data.data });
  }
  return { ok: true, records };
}

function projectAccountSpace(
  key: string,
  record: Record<string, unknown>,
): AccountSpacesOutput["spaces"][number] {
  const suffix = key.startsWith("spaces/") ? key.slice("spaces/".length) : key;
  const rawSpaceId = stringField(record, "space_id", "spaceId") ?? suffix;
  const rawName = stringField(record, "name") ?? rawSpaceId.split(":").at(-1) ?? rawSpaceId;
  const rawType = stringField(record, "type");
  const rawStatus = stringField(record, "status");
  const rawExpiresAt = record.expires_at ?? record.expiresAt;
  const expiresAt = rawExpiresAt instanceof Date
    ? rawExpiresAt.toISOString()
    : typeof rawExpiresAt === "string" && !Number.isNaN(new Date(rawExpiresAt).getTime())
    ? new Date(rawExpiresAt).toISOString()
    : undefined;
  return {
    spaceId: rawSpaceId,
    name: rawName,
    ownerDid: stringField(record, "owner_did", "ownerDid", "owner") ?? "",
    type: rawType === "owned" || rawType === "delegated" ? rawType : "discovered",
    permissions: Array.isArray(record.permissions)
      ? record.permissions.filter((value): value is string => typeof value === "string")
      : [],
    status: rawStatus === "archived" ? "archived" : "active",
    ...(stringField(record, "registered_at", "registeredAt") === undefined
      ? {}
      : { registeredAt: stringField(record, "registered_at", "registeredAt") }),
    ...(stringField(record, "updated_at", "updatedAt") === undefined
      ? {}
      : { updatedAt: stringField(record, "updated_at", "updatedAt") }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function projectAccountApplication(
  key: string,
  record: Record<string, unknown>,
): AccountApplicationsOutput["applications"][number] {
  const manifests = Array.isArray(record.manifests)
    ? record.manifests.filter(isRecord)
    : [];
  const first = manifests[0];
  return {
    appId: stringField(record, "app_id", "appId") ??
      stringField(first, "app_id") ??
      (key.startsWith("applications/") ? key.slice("applications/".length) : key),
    manifests,
    ...(stringField(record, "updated_at", "updatedAt") === undefined
      ? {}
      : { updatedAt: stringField(record, "updated_at", "updatedAt") }),
    ...(stringField(first, "name") === undefined ? {} : { name: stringField(first, "name") }),
    ...(stringField(first, "description") === undefined
      ? {}
      : { description: stringField(first, "description") }),
    ...(stringField(record, "manifest_hash", "manifestHash") === undefined
      ? {}
      : { manifestHash: stringField(record, "manifest_hash", "manifestHash") }),
  };
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeKvValue(value: unknown): Readonly<{
  value: unknown;
  encoding: KvGetOutput["encoding"];
}> {
  if (value instanceof Uint8Array) {
    return { value: Buffer.from(value).toString("base64"), encoding: "base64" };
  }
  return {
    value,
    encoding: typeof value === "string" ? "text" : "json",
  };
}

function nodeFailure(action: string): OperationExecutionOutcome<never> {
  return {
    status: "error",
    error: operationError(
      "NODE_ERROR",
      `The TinyCloud node could not ${action}.`,
      { retryable: true },
    ),
  };
}
