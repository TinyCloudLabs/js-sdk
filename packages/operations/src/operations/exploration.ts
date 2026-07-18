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
  readonly limit?: number;
}

interface KvListOutput {
  readonly space: string;
  readonly prefix: string;
  readonly keys: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
}

interface KvGetInput {
  readonly space: string;
  readonly key: string;
  readonly representation?: "base64" | "text" | "json";
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
  readonly byteLength: number;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type KvPutContent =
  | Readonly<{ encoding: "utf8"; value: string }>
  | Readonly<{ encoding: "json"; value: JsonValue }>
  | Readonly<{ encoding: "base64"; value: string }>;
type KvPutInput = Readonly<{
  space: string;
  key: string;
  content: KvPutContent;
  contentType?: string;
}> & (
  | Readonly<{ mode: "create" | "upsert" }>
  | Readonly<{ mode: "replace"; etag: string }>
);
interface KvPutOutput {
  readonly space: string;
  readonly key: string;
  readonly mode: "create" | "replace" | "upsert";
  readonly byteLength: number;
  readonly metadata: KvMetadata;
}
interface KvHeadInput { readonly space: string; readonly key: string }
interface KvHeadOutput { readonly space: string; readonly key: string; readonly metadata: KvMetadata }
interface KvDeleteInput { readonly space: string; readonly key: string; readonly etag?: string }
interface KvDeleteOutput { readonly space: string; readonly key: string; readonly deleted: true; readonly etag?: string }
interface KvMetadata {
  readonly etag?: string;
  readonly contentType?: string;
  readonly lastModified?: string;
  readonly contentLength?: number;
}
type KvOperationResult<T> =
  | Readonly<{ ok: true; data: T }>
  | Readonly<{ ok: false; error: Readonly<{ code?: string; meta?: Readonly<Record<string, unknown>> }> }>;
interface KvOperationHandle {
  list(options: Readonly<{ prefix?: string; limit: number }>): Promise<KvOperationResult<{
    readonly keys: readonly string[];
    readonly truncated?: boolean;
  }>>;
  get(key: string, options: Readonly<{
    binary: true;
    maxResponseBytes: number;
  }>): Promise<KvOperationResult<{ readonly data: Uint8Array; readonly headers: KvMetadata }>>;
  head(key: string): Promise<KvOperationResult<{ readonly data: void; readonly headers: KvMetadata }>>;
  put(key: string, value: Uint8Array, options: Readonly<{
    contentType: string;
    ifNoneMatch?: "*";
    ifMatch?: string;
  }>): Promise<KvOperationResult<{ readonly data: void; readonly headers: KvMetadata }>>;
  delete(key: string, options: Readonly<{ ifMatch?: string }>): Promise<KvOperationResult<{
    readonly data: void;
    readonly headers: KvMetadata;
  }>>;
}

const MAX_KV_VALUE_BYTES = 1024 * 1024;
const DEFAULT_KV_LIST_LIMIT = 100;
const MAX_ACCOUNT_REGISTRY_RECORDS = 1000;
const MAX_ACCOUNT_REGISTRY_BYTES = 4 * 1024 * 1024;

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
const LimitSchema = z.number().int().min(1).max(1000);
const StrongEtagSchema = z.string().regex(
  /^"blake3-[0-9a-f]{64}"$/,
  "A strong TinyCloud BLAKE3 ETag is required.",
);
const ContentTypeSchema = z.string().min(1).max(128).refine(
  (value) => !/[\x00-\x1f\x7f]/.test(value),
  "Invalid content type.",
);
const JsonNumberSchema = z.number().finite().refine(
  (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
  "JSON integer values must be JavaScript safe integers.",
);
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  JsonNumberSchema,
  z.string(),
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));
const KvMetadataSchema: z.ZodType<KvMetadata> = z.object({
  etag: z.string().optional(),
  contentType: z.string().optional(),
  lastModified: z.string().optional(),
  contentLength: z.number().int().nonnegative().optional(),
}).strict();

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
  limit: LimitSchema.optional(),
}).strict();
const KvListOutputSchema: z.ZodType<KvListOutput> = z.object({
  space: z.string().min(1),
  prefix: z.string(),
  keys: z.array(z.string()),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

const KvGetInputSchema: z.ZodType<KvGetInput> = z.object({
  space: SpaceSchema,
  key: KeySchema,
  representation: z.enum(["base64", "text", "json"]).optional(),
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
  metadata: KvMetadataSchema,
  byteLength: z.number().int().nonnegative(),
}).strict();

const KvPutContentSchema: z.ZodType<KvPutContent> = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("utf8"), value: z.string() }).strict(),
  z.object({ encoding: z.literal("json"), value: JsonValueSchema }).strict(),
  z.object({ encoding: z.literal("base64"), value: z.string() }).strict(),
]).superRefine((content, context) => {
  const decoded = decodeKvPutContent(content);
  if (decoded === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid canonical base64 content." });
  } else if (decoded.byteLength > MAX_KV_VALUE_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      type: "array",
      maximum: MAX_KV_VALUE_BYTES,
      inclusive: true,
      message: `KV content must not exceed ${MAX_KV_VALUE_BYTES} bytes.`,
    });
  }
});
const KvPutCommonSchema = {
  space: SpaceSchema,
  key: KeySchema,
  content: KvPutContentSchema,
  contentType: ContentTypeSchema.optional(),
};
const KvPutInputSchema: z.ZodType<KvPutInput> = z.discriminatedUnion("mode", [
  z.object({ ...KvPutCommonSchema, mode: z.literal("create") }).strict(),
  z.object({ ...KvPutCommonSchema, mode: z.literal("upsert") }).strict(),
  z.object({ ...KvPutCommonSchema, mode: z.literal("replace"), etag: StrongEtagSchema }).strict(),
]);
const KvPutOutputSchema: z.ZodType<KvPutOutput> = z.object({
  space: z.string().min(1),
  key: z.string().min(1),
  mode: z.enum(["create", "replace", "upsert"]),
  byteLength: z.number().int().nonnegative(),
  metadata: KvMetadataSchema,
}).strict();
const KvHeadInputSchema: z.ZodType<KvHeadInput> = z.object({ space: SpaceSchema, key: KeySchema }).strict();
const KvHeadOutputSchema: z.ZodType<KvHeadOutput> = z.object({
  space: z.string().min(1), key: z.string().min(1), metadata: KvMetadataSchema,
}).strict();
const KvDeleteInputSchema: z.ZodType<KvDeleteInput> = z.object({
  space: SpaceSchema, key: KeySchema, etag: StrongEtagSchema.optional(),
}).strict();
const KvDeleteOutputSchema: z.ZodType<KvDeleteOutput> = z.object({
  space: z.string().min(1), key: z.string().min(1), deleted: z.literal(true), etag: z.string().optional(),
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
const KV_PUT_SENSITIVITY: OperationSensitivity = { input: ["/key", "/content"], output: [] };
const KV_KEY_SENSITIVITY: OperationSensitivity = { input: ["/key"], output: [] };

type ExplorationDefinition =
  | OperationDefinition<EmptyInput, AccountSpacesOutput>
  | OperationDefinition<EmptyInput, AccountApplicationsOutput>
  | OperationDefinition<KvListInput, KvListOutput>
  | OperationDefinition<KvGetInput, KvGetOutput>
  | OperationDefinition<KvPutInput, KvPutOutput>
  | OperationDefinition<KvHeadInput, KvHeadOutput>
  | OperationDefinition<KvDeleteInput, KvDeleteOutput>;

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
    description: "Read one exact key with a node-enforced one MiB response limit.",
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
  {
    id: "tinycloud.kv.head", version: 1, title: "Inspect TinyCloud KV metadata",
    description: "Read metadata for one exact key without downloading its value.",
    input: KvHeadInputSchema, output: KvHeadOutputSchema, effects: ["read"], runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES, exposure: EXPLORATION_EXPOSURE, sensitivity: KV_KEY_SENSITIVITY,
    authority: (context: RuntimeOperationContext, input: KvHeadInput) =>
      planExactKv(context, input.space, input.key, "tinycloud.kv/metadata"),
    execute: executeKvHead,
  },
  {
    id: "tinycloud.kv.put", version: 1, title: "Write a TinyCloud KV value",
    description: "Create, conditionally replace, or explicitly upsert one exact KV key.",
    input: KvPutInputSchema, output: KvPutOutputSchema, effects: ["write"], runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES, exposure: EXPLORATION_EXPOSURE, sensitivity: KV_PUT_SENSITIVITY,
    authority: (context: RuntimeOperationContext, input: KvPutInput) =>
      planExactKv(context, input.space, input.key, "tinycloud.kv/put"),
    execute: executeKvPut,
  },
  {
    id: "tinycloud.kv.delete", version: 1, title: "Delete a TinyCloud KV value",
    description: "Delete one exact KV key, optionally only when its ETag still matches.",
    input: KvDeleteInputSchema, output: KvDeleteOutputSchema, effects: ["destructive"], runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES, exposure: EXPLORATION_EXPOSURE, sensitivity: KV_KEY_SENSITIVITY,
    authority: (context: RuntimeOperationContext, input: KvDeleteInput) =>
      planExactKv(context, input.space, input.key, "tinycloud.kv/del"),
    execute: executeKvDelete,
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
  const space = resolveGenericKvSpace(context, input.space);
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
  const space = resolveGenericKvSpace(context, input.space);
  return [{
    service: "tinycloud.kv",
    space,
    path: input.key,
    actions: ["tinycloud.kv/get"],
  }];
}

async function planExactKv(
  context: RuntimeOperationContext,
  requestedSpace: string,
  key: string,
  action: "tinycloud.kv/metadata" | "tinycloud.kv/put" | "tinycloud.kv/del",
): Promise<readonly CapabilityRequirement[]> {
  return [{
    service: "tinycloud.kv",
    space: resolveGenericKvSpace(context, requestedSpace),
    path: key,
    actions: [action],
  }];
}

async function executeAccountSpacesList(
  context: OperationContext,
  _input: EmptyInput,
): Promise<OperationExecutionOutcome<AccountSpacesOutput>> {
  try {
    const entries = await readAccountRegistry(context, "spaces/");
    if (!entries.ok) return entries.outcome;
    const spaces = entries.records
      .map(({ key, value }) => projectAccountSpace(key, value))
      .sort((left, right) => left.name.localeCompare(right.name) || left.spaceId.localeCompare(right.spaceId));
    const output = { spaces, count: spaces.length };
    return accountRegistryOutput(output);
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
    if (!entries.ok) return entries.outcome;
    const applications = entries.records
      .map(({ key, value }) => projectAccountApplication(key, value))
      .sort((left, right) => left.appId.localeCompare(right.appId));
    const output = { applications, count: applications.length };
    return accountRegistryOutput(output);
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
    const space = resolveGenericKvSpace(runtime, input.space);
    const result = await genericKv(runtime, space).list({
      ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
      limit: input.limit ?? DEFAULT_KV_LIST_LIMIT,
    });
    if (!result.ok) return nodeFailure("list KV keys");
    const keys = [...result.data.keys];
    return {
      status: "ok",
      output: {
        space,
        prefix: input.prefix ?? "",
        keys,
        count: keys.length,
        truncated: result.data.truncated ?? false,
      },
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
    const space = resolveGenericKvSpace(runtime, input.space);
    const result = await genericKv(runtime, space).get(input.key, {
      binary: true,
      maxResponseBytes: MAX_KV_VALUE_BYTES,
    });
    if (!result.ok) return kvFailure(result.error, "read the KV value");
    const bytes = result.data.data;
    if (bytes.byteLength > MAX_KV_VALUE_BYTES) {
      return kvFailure({ code: "KV_RESPONSE_TOO_LARGE" }, "read the KV value");
    }
    const encoded = encodeKvValue(bytes, input.representation ?? "base64");
    if (!encoded.ok) return encoded.outcome;
    return {
      status: "ok",
      output: {
        space,
        key: input.key,
        value: encoded.value,
        encoding: encoded.encoding,
        metadata: projectKvMetadata(result.data.headers),
        byteLength: bytes.byteLength,
      },
    };
  } catch (error) {
    if (error instanceof OperationInvocationError) {
      return { status: "error", error: error.operationError };
    }
    return nodeFailure("read the KV value");
  }
}

async function executeKvHead(
  context: OperationContext,
  input: KvHeadInput,
): Promise<OperationExecutionOutcome<KvHeadOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveGenericKvSpace(runtime, input.space);
    const result = await genericKv(runtime, space).head(input.key);
    if (!result.ok) return kvFailure(result.error, "read KV metadata");
    return { status: "ok", output: { space, key: input.key, metadata: projectKvMetadata(result.data.headers) } };
  } catch (error) {
    return caughtKvFailure(error, "read KV metadata");
  }
}

async function executeKvPut(
  context: OperationContext,
  input: KvPutInput,
): Promise<OperationExecutionOutcome<KvPutOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveGenericKvSpace(runtime, input.space);
    const decoded = decodeKvPutContent(input.content);
    if (decoded === undefined || decoded.byteLength > MAX_KV_VALUE_BYTES) {
      return { status: "error", error: operationError("INPUT_INVALID", "The KV content is invalid or too large.") };
    }
    const result = await genericKv(runtime, space).put(input.key, decoded.bytes, {
      contentType: input.contentType ?? decoded.contentType,
      ...(input.mode === "create" ? { ifNoneMatch: "*" as const } : {}),
      ...(input.mode === "replace" ? { ifMatch: input.etag } : {}),
    });
    if (!result.ok) return kvFailure(result.error, "write the KV value");
    return {
      status: "ok",
      output: {
        space,
        key: input.key,
        mode: input.mode,
        byteLength: decoded.byteLength,
        metadata: projectKvMetadata(result.data.headers),
      },
    };
  } catch (error) {
    return caughtKvFailure(error, "write the KV value");
  }
}

async function executeKvDelete(
  context: OperationContext,
  input: KvDeleteInput,
): Promise<OperationExecutionOutcome<KvDeleteOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveGenericKvSpace(runtime, input.space);
    const result = await genericKv(runtime, space).delete(input.key, {
      ...(input.etag === undefined ? {} : { ifMatch: input.etag }),
    });
    if (!result.ok) return kvFailure(result.error, "delete the KV value");
    return {
      status: "ok",
      output: {
        space,
        key: input.key,
        deleted: true,
        ...(result.data.headers.etag === undefined ? {} : { etag: result.data.headers.etag }),
      },
    };
  } catch (error) {
    return caughtKvFailure(error, "delete the KV value");
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

function genericKv(context: RuntimeOperationContext, space: string): KvOperationHandle {
  return runtimeNode(context).kvForSpace(space) as unknown as KvOperationHandle;
}

function resolveSpace(context: RuntimeOperationContext, space: string): string {
  return operationSpaceResolver(context.runtime.node, context.summary.space)(space);
}

function resolveGenericKvSpace(context: RuntimeOperationContext, space: string): string {
  const resolved = resolveSpace(context, space);
  const protectedName = resolved.split(":").at(-1)?.toLowerCase();
  if (protectedName === "secrets" || protectedName === "account") {
    throw new OperationInvocationError(operationError(
      "INPUT_INVALID",
      "Generic KV operations cannot access TinyCloud account or secrets spaces.",
    ));
  }
  return resolved;
}

async function readAccountRegistry(
  context: OperationContext,
  prefix: "spaces/" | "applications/",
): Promise<
  | Readonly<{ ok: true; records: readonly Readonly<{ key: string; value: Record<string, unknown> }>[] }>
  | Readonly<{ ok: false; outcome: OperationExecutionOutcome<never> }>
> {
  const runtime = runtimeContext(context);
  const accountSpace = resolveSpace(runtime, "account");
  const kv = runtimeNode(runtime).kvForSpace(accountSpace) as unknown as KvOperationHandle;
  const listed = await kv.list({ prefix, limit: MAX_ACCOUNT_REGISTRY_RECORDS });
  if (!listed.ok) return { ok: false, outcome: nodeFailure("list the account registry") };
  if (listed.data.truncated === true) {
    return {
      ok: false,
      outcome: {
        status: "error",
        error: operationError(
          "OUTPUT_INVALID",
          `The TinyCloud account registry exceeds the ${MAX_ACCOUNT_REGISTRY_RECORDS}-record exploration limit.`,
        ),
      },
    };
  }

  const records: Array<Readonly<{ key: string; value: Record<string, unknown> }>> = [];
  let totalBytes = 0;
  for (const key of listed.data.keys) {
    const loaded = await kv.get(key, {
      binary: true,
      maxResponseBytes: MAX_KV_VALUE_BYTES,
    });
    if (!loaded.ok) {
      return { ok: false, outcome: kvFailure(loaded.error, "read the account registry") };
    }
    const bytes = loaded.data.data;
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_KV_VALUE_BYTES || totalBytes > MAX_ACCOUNT_REGISTRY_BYTES) {
      return {
        ok: false,
        outcome: {
          status: "error",
          error: operationError(
            "KV_RESPONSE_TOO_LARGE",
            `The TinyCloud account registry exceeds the ${MAX_ACCOUNT_REGISTRY_BYTES}-byte exploration limit.`,
          ),
        },
      };
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(value)) throw new TypeError("Account registry values must be JSON objects.");
      records.push({ key, value });
    } catch {
      return {
        ok: false,
        outcome: {
          status: "error",
          error: operationError("OUTPUT_INVALID", "The TinyCloud account registry contains an invalid record."),
        },
      };
    }
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

function encodeKvValue(
  value: Uint8Array,
  representation: NonNullable<KvGetInput["representation"]>,
):
  | Readonly<{ ok: true; value: unknown; encoding: KvGetOutput["encoding"] }>
  | Readonly<{ ok: false; outcome: OperationExecutionOutcome<KvGetOutput> }> {
  if (representation === "base64") {
    return { ok: true, value: Buffer.from(value).toString("base64"), encoding: "base64" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return {
      ok: false,
      outcome: { status: "error", error: operationError("OUTPUT_INVALID", "The KV value is not valid UTF-8.") },
    };
  }
  if (representation === "text") return { ok: true, value: text, encoding: "text" };
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        ok: false,
        outcome: {
          status: "error",
          error: operationError(
            "OUTPUT_INVALID",
            "The KV JSON contains a number that cannot be represented safely.",
          ),
        },
      };
    }
    return { ok: true, value: parsed.data, encoding: "json" };
  } catch {
    return {
      ok: false,
      outcome: { status: "error", error: operationError("OUTPUT_INVALID", "The KV value is not valid JSON.") },
    };
  }
}

function decodeKvPutContent(content: KvPutContent):
  | Readonly<{ bytes: Uint8Array; byteLength: number; contentType: string }>
  | undefined {
  let bytes: Uint8Array;
  let contentType: string;
  if (content.encoding === "utf8") {
    bytes = new TextEncoder().encode(content.value);
    contentType = "text/plain;charset=UTF-8";
  } else if (content.encoding === "json") {
    bytes = new TextEncoder().encode(JSON.stringify(content.value));
    contentType = "application/json";
  } else {
    if (!isCanonicalBase64(content.value)) return undefined;
    bytes = new Uint8Array(Buffer.from(content.value, "base64"));
    contentType = "application/octet-stream";
  }
  return { bytes, byteLength: bytes.byteLength, contentType };
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function projectKvMetadata(headers: {
  readonly etag?: string;
  readonly contentType?: string;
  readonly lastModified?: string;
  readonly contentLength?: number;
}): KvMetadata {
  return {
    ...(headers.etag === undefined ? {} : { etag: headers.etag }),
    ...(headers.contentType === undefined ? {} : { contentType: headers.contentType }),
    ...(headers.lastModified === undefined ? {} : { lastModified: headers.lastModified }),
    ...(headers.contentLength === undefined ? {} : { contentLength: headers.contentLength }),
  };
}

function caughtKvFailure(error: unknown, action: string): OperationExecutionOutcome<never> {
  if (error instanceof OperationInvocationError) return { status: "error", error: error.operationError };
  return nodeFailure(action);
}

function accountRegistryOutput<T>(output: T): OperationExecutionOutcome<T> {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_ACCOUNT_REGISTRY_BYTES) {
    return {
      status: "error",
      error: operationError(
        "KV_RESPONSE_TOO_LARGE",
        `The TinyCloud account registry exceeds the ${MAX_ACCOUNT_REGISTRY_BYTES}-byte exploration limit.`,
      ),
    };
  }
  return { status: "ok", output };
}

function kvFailure(
  error: Readonly<{ code?: string; meta?: Readonly<Record<string, unknown>> }>,
  action: string,
): OperationExecutionOutcome<never> {
  if (error.code === "KV_NOT_FOUND") {
    return { status: "error", error: operationError("KV_NOT_FOUND", "The TinyCloud KV key was not found.") };
  }
  if (error.code === "KV_PRECONDITION_FAILED") {
    return { status: "error", error: operationError("KV_PRECONDITION_FAILED", "The TinyCloud KV object changed or already exists.") };
  }
  if (error.code === "KV_CONFLICT") {
    return {
      status: "error",
      error: operationError(
        "KV_CONFLICT",
        "A database serialization conflict prevented the conditional KV mutation; re-read the key state, which may still be absent, before deciding whether to retry.",
        { retryable: true },
      ),
    };
  }
  if (error.code === "KV_RESPONSE_TOO_LARGE") {
    return { status: "error", error: operationError("KV_RESPONSE_TOO_LARGE", `The TinyCloud KV value exceeds ${MAX_KV_VALUE_BYTES} bytes.`) };
  }
  return nodeFailure(action);
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
