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

type PrimarySpaceIdentity = Pick<SpaceCreationContext, "address" | "chainId" | "spaceId">;

export interface PrimarySpaceCreationPorts {
  handler: ISpaceCreationHandler;
  session?: PrimarySpaceIdentity;
  context?: SpaceCreationContext;
  currentSession?(): unknown;
  signerAddress?(): Promise<string>;
  resolveHost?(): Promise<string>;
  domain?: string;
  hostName?: string;
  /** `assertMayCreateSpace`, reporting a refusal to the handler. */
  guard(context: SpaceCreationContext): Promise<void>;
  /** Confirm that the host delegation should be submitted. */
  host(
    context: SpaceCreationContext,
    assertCurrent: () => void,
    siweParameters: (peerId: string) => {
      address: string;
      chainId: number;
      domain: string;
      issuedAt: string;
      spaceId: string;
      peerId: string;
    },
  ): Promise<SpaceHostResult>;
  /** Called once the node has the host delegation. */
  onHosted(context: SpaceCreationContext): void;
  /** Register the session delegation again. */
  activate(context: SpaceCreationContext): Promise<SpaceHostResult>;
  signal?: AbortSignal;
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
export async function createPrimarySpace({
  handler,
  session,
  context: existingContext,
  currentSession,
  signerAddress,
  resolveHost,
  domain,
  hostName,
  guard,
  host,
  onHosted,
  activate,
  signal,
}: PrimarySpaceCreationPorts): Promise<void> {
  const checkCurrent = () => {
    signal?.throwIfAborted();
    if (session && currentSession?.() !== session) throw new Error("Space hosting session changed");
  };
  checkCurrent();
  if (session && signerAddress && (await signerAddress()).toLowerCase() !== session.address.toLowerCase()) return;
  checkCurrent();
  const context = existingContext ?? (session && {
    address: session.address,
    chainId: session.chainId,
    spaceId: session.spaceId,
    host: await resolveHost?.() ?? hostName ?? "",
  });
  if (!context) throw new Error("Space hosting requires a session context");
  checkCurrent();
  await guard(context);
  checkCurrent();
  const approved = await handler.confirmSpaceCreation(context);
  checkCurrent();
  if (!approved) return;

  try {
    const created = await host(context, checkCurrent, (peerId) => ({
      address: context.address,
      chainId: context.chainId,
      domain: domain ?? "",
      issuedAt: new Date().toISOString(),
      spaceId: context.spaceId,
      peerId,
    }));
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
  checkCurrent();
  onHosted(context);

  // Small delay to allow space creation to propagate
  await new Promise((resolve) => setTimeout(resolve, 100));
  checkCurrent();

  const retry = await activate(context);
  checkCurrent();
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

/** Add the bounded host lifetime before any wallet signature. */
export function withHostExpiry(siwe: string, now: Date, hostingYears: number, requestedExpiry?: string): string {
  if (/[\r\u0085\u2028\u2029]/.test(siwe)) {
    throw new Error("Host SIWE contains an unsupported line separator");
  }
  const lines = siwe.split("\n");
  if (lines.some((line) => line.startsWith("Expiration Time:"))) {
    throw new Error("Host SIWE already contains Expiration Time");
  }
  // SIWE has an optional single-line statement, then fixed URI/version/chain/nonce/time fields.
  const uriIndex = lines[3] === "" ? 4 : 5;
  const issuedAtIndex = uriIndex + 4;
  if (!lines[uriIndex]?.startsWith("URI: ") || !lines[issuedAtIndex]?.startsWith("Issued At: ")) {
    throw new Error("Host SIWE has no positional Issued At field");
  }

  const ceiling = new Date(now);
  const day = ceiling.getUTCDate();
  ceiling.setUTCDate(1);
  ceiling.setUTCFullYear(ceiling.getUTCFullYear() + hostingYears);
  const lastDay = new Date(Date.UTC(ceiling.getUTCFullYear(), ceiling.getUTCMonth() + 1, 0)).getUTCDate();
  ceiling.setUTCDate(Math.min(day, lastDay));
  const requested = requestedExpiry === undefined ? ceiling.getTime() : Date.parse(requestedExpiry);
  if (!Number.isFinite(requested) || requested <= now.getTime()) {
    throw new Error("Host expiry must be a valid future timestamp");
  }
  const expiry = new Date(Math.min(requested, ceiling.getTime())).toISOString();
  lines.splice(issuedAtIndex + 1, 0, `Expiration Time: ${expiry}`);
  return lines.join("\n");
}
