/**
 * The hosting probe's read selection and classification, and the sequence that
 * creates a primary space that is not hosted. Both are loaded on first use, so
 * browser bundles carry them as a separate file rather than in their root.
 */
import type { ISpaceCreationHandler, SpaceCreationContext, SpaceHostResult } from "@tinycloud/sdk-core";
import type { FetchFunction, InvokeAnyEntry, ServiceHeaders } from "@tinycloud/sdk-services";
import type { SpaceHosting } from "./authorization/NodeUserAuthorization";

/** A permission the session holds, as `TinyCloudNode` tracks it. */
export interface SpaceHostingOperation {
  spaceId?: string;
  resource?: string;
  service: string;
  path: string;
  action: string;
  caveats?: Record<string, unknown>[];
}

/** One read to send: `service`, `path` and `action` are what the invocation is signed for. */
export interface SpaceHostingRead {
  service: string;
  path: string;
  action: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SpaceHostingPorts {
  spaceId: string;
  /** Everything the session holds, on any space: its own recap and installed runtime grants. */
  operations: readonly SpaceHostingOperation[];
  /** Whether `granted` authorizes `requested`. */
  covers(granted: SpaceHostingOperation, requested: SpaceHostingOperation): boolean;
  /** Identifies the session's services: `hosted` answers are remembered per scope, so a later session never inherits one. */
  scope: object;
  host: string;
  fetch: FetchFunction;
  /** Sign an invocation for exactly these entries. `invoke` would always sign for the session's primary space. */
  sign(entries: InvokeAnyEntry[]): ServiceHeaders;
  /** Register the session delegation with the node. Rejects on a network failure or timeout. */
  activate(signal: AbortSignal): Promise<unknown>;
}

/** Spaces the node answered `hosted` for, by session: hosting does not go away in normal operation. */
const hostedBy = new WeakMap<object, Set<string>>();

/** Per request: the probe never holds up a caller longer. */
const TIMEOUT_MS = 5_000;

/** A key that does not exist: a hosted space answers a read of it with a plain 404. */
const SPACE_PROBE_KEY = ".tinycloud-space-probe";
const KV_LIST_ACTION = "tinycloud.kv/list";
const KV_METADATA_ACTION = "tinycloud.kv/metadata";
const KV_GET_ACTION = "tinycloud.kv/get";
const SPACE_INFO_ACTION = "tinycloud.space/info";

const isPrefix = (path: string) =>
  path === "" || path.endsWith("/") || path.endsWith("/*") || path.endsWith("/**");
const prefixOf = (path: string) =>
  path.endsWith("/**") ? path.slice(0, -2) : path.endsWith("/*") ? path.slice(0, -1) : path === "/" ? "" : path;
// A prefix grant is read at a key that does not exist; a grant on one key reads that key.
const keyOf = (path: string) => isPrefix(path) ? `${prefixOf(path)}${SPACE_PROBE_KEY}` : path;

/**
 * The cheapest read of the space the session already holds: never one that
 * downloads a body when another exists. Reads under a caveated grant are
 * skipped, since their limits are not known here.
 */
function selectRead({ spaceId, operations, covers }: SpaceHostingPorts): SpaceHostingRead | undefined {
  // Held on this space: `covers` an operation's own action and path only when it names this space and no resource.
  const held = operations.filter((operation) =>
    !operation.caveats?.length &&
    covers(operation, { spaceId, service: operation.service, path: operation.path, action: operation.action }));
  const holding = (service: string, action: string) =>
    held.filter((operation) => covers(operation, { spaceId, service, path: operation.path, action }));

  return [
    ...holding("kv", KV_LIST_ACTION).map((operation) => ({
      service: "kv",
      path: isPrefix(operation.path) ? prefixOf(operation.path) : operation.path,
      action: KV_LIST_ACTION,
      headers: { "x-tinycloud-limit": "1" },
    })),
    ...holding("kv", KV_METADATA_ACTION).map((operation) => ({
      service: "kv", path: keyOf(operation.path), action: KV_METADATA_ACTION,
    })),
    ...holding("space", SPACE_INFO_ACTION).map(() => ({
      service: "space", path: "", action: SPACE_INFO_ACTION, body: "{}",
    })),
    ...holding("kv", KV_GET_ACTION).map((operation) => ({
      service: "kv", path: keyOf(operation.path), action: KV_GET_ACTION,
    })),
  ].find((read) => held.some((operation) =>
    covers(operation, { spaceId, service: read.service, path: read.path, action: read.action })));
}

/** One signed read, classified. */
async function send(ports: SpaceHostingPorts, read: SpaceHostingRead): Promise<SpaceHosting | "refused"> {
  try {
    const { spaceId } = ports;
    const response = await ports.fetch(`${ports.host}/invoke`, {
      method: "POST",
      headers: { ...ports.sign([{ spaceId, service: read.service, path: read.path, action: read.action }]), ...read.headers },
      body: read.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      // A 2xx is the answer; a body that comes with it is not wanted.
      if (response.body instanceof ReadableStream) await response.body.cancel().catch(() => undefined);
      return "hosted";
    }
    if (response.status === 401 || response.status === 403) return "refused";
    if (response.status === 404) {
      // Only the node's unhosted-space 404 says "not hosted"; a missing key is a 404 too.
      return /space not found/i.test(await response.text()) ? "not-hosted" : "hosted";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ask the node whether the space is hosted. A 401/403 registers the session
 * delegation once and asks once more; still refused is `unknown`, as are
 * network failures, 5xx and a session that holds no read.
 */
export async function askSpaceHosting(ports: SpaceHostingPorts): Promise<SpaceHosting> {
  const read = selectRead(ports);
  if (!read) return "unknown";
  // Only a session that holds a read on the space is answered from what it already saw.
  // The address in a space id is case-insensitive; the rest of it is not.
  const key = `${ports.host} ${ports.spaceId.replace(/^(tinycloud:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})/, (_, prefix: string, address: string) => prefix + address.toLowerCase())}`;
  if (hostedBy.get(ports.scope)?.has(key)) return "hosted";
  let outcome = await send(ports, read);
  if (outcome === "refused") {
    try {
      await ports.activate(AbortSignal.timeout(TIMEOUT_MS));
    } catch {
      return "unknown";
    }
    outcome = await send(ports, read);
  }
  if (outcome === "hosted") hostedBy.set(ports.scope, (hostedBy.get(ports.scope) ?? new Set<string>()).add(key));
  return outcome === "refused" ? "unknown" : outcome;
}

export interface PrimarySpaceCreationPorts {
  handler: ISpaceCreationHandler;
  context: SpaceCreationContext;
  /** `assertMayCreateSpace`, reporting a refusal to the handler. */
  guard(): Promise<void>;
  /** Submit the host delegation for the primary space. */
  host(): Promise<SpaceHostResult>;
  /** Called once the node has the host delegation. */
  onHosted(): void;
  /** Register the session delegation again. */
  activate(): Promise<SpaceHostResult>;
}

/** `<status> - <server text>` for a failed host call. */
function describeFailure(result: SpaceHostResult): string {
  const text = result.error?.trim();
  return text ? `${result.status} - ${text}` : `${result.status}`;
}

/**
 * The guard, confirm, host and re-activate sequence for an unhosted primary
 * space. A declined confirmation ends it quietly; a failure is reported to the
 * handler and thrown.
 */
export async function createPrimarySpace({ handler, context, guard, host, onHosted, activate }: PrimarySpaceCreationPorts): Promise<void> {
  await guard();
  if (!await handler.confirmSpaceCreation(context)) return;

  try {
    const created = await host();
    if (!created.success) {
      throw Object.assign(
        new Error(`Failed to create space ${context.spaceId}: ${describeFailure(created)}`),
        { cause: created },
      );
    }
  } catch (error) {
    handler.onSpaceCreationFailed?.(context, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  onHosted();

  // Small delay to allow space creation to propagate
  await new Promise((resolve) => setTimeout(resolve, 100));

  const retry = await activate();
  if (!retry.success) {
    const err = Object.assign(
      new Error(`Failed to activate session after creating space: ${describeFailure(retry)}`),
      { cause: retry },
    );
    handler.onSpaceCreationFailed?.(context, err);
    throw err;
  }
  handler.onSpaceCreated?.(context);
}
