import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode, OPENKEY_SPACE_SETUP_RETRY_HINT } from "../config/constants.js";
import { restoreProfileSessionNode, type ProfileSessionContext, type ProfileSessionRestore } from "../lib/sdk.js";
import { CLIError } from "../output/errors.js";

/**
 * OpenKey hands the CLI its delegation before it has hosted the account's
 * `default` space: the setup runs in the background after the approval and the
 * relay only reports where it stands (`spaceReady`, `spacePending`,
 * `spaceError`). Without a wait, the first storage call can fail with
 * `404 Space not found` (TC-1608).
 *
 * This module only reads. It never signs a delegation, requests an ability or
 * hosts a space: it re-asks the node, with the session the login just saved,
 * whether a read of the space still fails as unhosted.
 */

/** How long a login waits for OpenKey to host the space (Courier waits the same). */
export const SPACE_SETUP_TIMEOUT_MS = 150_000;
/** Sleeps between probes; the last one repeats. */
const POLL_DELAYS_MS: readonly number[] = [2_000, 3_000, 5_000, 8_000, 13_000, 15_000];
/** Seconds of waiting between two "still setting up" progress lines. */
const PROGRESS_INTERVAL_MS = 15_000;
const SPACE_ERROR_MAX_LENGTH = 500;

/** What one read of the space showed. `unknown`: it could not be told (no readable grant, or a failure that is not the unhosted 404). */
export type SpaceProbeResult = "hosted" | "unhosted" | "unknown";

/** OpenKey's account of the space setup, when it is not a plain success. */
export interface SpaceSetupReport {
  /** `false`: OpenKey will not host it; `null`: setup is running; absent: not reported. */
  readonly ready: boolean | null | undefined;
  readonly pending: boolean;
  /** OpenKey's `spaceError`, verbatim (control characters removed, bounded), including its error code. */
  readonly error?: string;
}

/**
 * The part of a relayed delegation that says the space is not ready, or
 * undefined when OpenKey said it is ready or said nothing (older deployments
 * omit the fields; they are never waited on).
 */
export function spaceSetupReport(delegation: Record<string, unknown>): SpaceSetupReport | undefined {
  const rawError = typeof delegation.spaceError === "string" ? delegation.spaceError : undefined;
  // OpenKey's text is printed to a terminal: one line, no control characters.
  const error = rawError?.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, SPACE_ERROR_MAX_LENGTH);
  const pending = delegation.spacePending === true;
  const ready = delegation.spaceReady;
  if (!pending && !error && ready !== false && ready !== null) return undefined;
  return {
    ready: ready === true || ready === false || ready === null ? ready : undefined,
    pending,
    ...(error ? { error } : {}),
  };
}

export interface SpaceSetupDependencies {
  probe(): Promise<SpaceProbeResult>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  timeoutMs?: number;
  /** One line to the operator; stderr by default. */
  write?(line: string): void;
}

/**
 * Act on OpenKey's report after the session was saved.
 *
 * - A read that already works ends it (a `spaceError` is still reported as a warning).
 * - `spaceError` with the space still unhosted fails with `SPACE_SETUP_FAILED`, OpenKey's error kept in the message.
 * - `spacePending` with the space unhosted polls up to {@link SPACE_SETUP_TIMEOUT_MS}; then `SPACE_SETUP_PENDING`.
 * - `spaceReady: false` alone (auto-sign off, external wallet): OpenKey will not host it, so waiting cannot help; it warns.
 * - A space this session cannot read (no kv grant) is never waited on; it warns.
 */
export async function awaitSpaceSetup(report: SpaceSetupReport, deps: SpaceSetupDependencies): Promise<void> {
  const write = deps.write ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SPACE_SETUP_TIMEOUT_MS;
  const started = now();
  const deadline = started + timeoutMs;
  const probe = async (): Promise<SpaceProbeResult> => deps.probe().catch(() => "unknown" as const);

  const first = await probe();
  if (first === "hosted") {
    if (report.error) write(`Warning: OpenKey reported a problem finishing your account setup: ${report.error}`);
    return;
  }
  if (first === "unknown") {
    write(
      `Warning: could not check whether your TinyCloud space is hosted${report.error ? `; OpenKey reported: ${report.error}` : report.pending ? "; OpenKey is still setting it up" : ""}. ` +
      `If the first storage command fails with "Space not found", OpenKey is still setting up your space. ${OPENKEY_SPACE_SETUP_RETRY_HINT}`,
    );
    return;
  }

  if (report.error) {
    throw new CLIError(
      "SPACE_SETUP_FAILED",
      `OpenKey could not finish setting up your space: ${report.error} Your login is saved, but storage commands will fail with "Space not found" until the space is hosted.`,
      ExitCode.ERROR,
      { hint: "Approve again in OpenKey to re-run the setup, then retry." },
    );
  }
  if (!report.pending) {
    write(
      "Warning: OpenKey did not set up your TinyCloud space (spaceReady: false), so storage commands will fail with \"Space not found\". " +
      "Turn on Auto-Sign in OpenKey and approve again, or host the space from a wallet profile.",
    );
    return;
  }

  write("Setting up your space… (OpenKey is hosting it; this can take a minute or two)");
  let lastProgress = started;
  for (let attempt = 0; ; attempt++) {
    const current = now();
    if (current >= deadline) break;
    await sleep(Math.min(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]!, deadline - current));
    if (await probe() === "hosted") {
      write("Your space is ready.");
      return;
    }
    const elapsed = now();
    if (elapsed < deadline && elapsed - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = elapsed;
      write(`Still setting up your space… (${Math.round((elapsed - started) / 1000)}s)`);
    }
  }
  throw new CLIError(
    "SPACE_SETUP_PENDING",
    `OpenKey is still setting up your space after ${Math.round(timeoutMs / 1000)} seconds. Your login is saved, but storage commands will fail with "Space not found" until the space is hosted.`,
    ExitCode.ERROR,
    { hint: OPENKEY_SPACE_SETUP_RETRY_HINT },
  );
}

function hasKvAction(permission: PermissionEntry, action: "list" | "get"): boolean {
  return permission.actions.some((entry) => entry === action || entry === `tinycloud.kv/${action}`);
}

/** A read the session's own kv grant allows: a list under a granted prefix, else a get of a key there. */
function readTarget(permissions: readonly PermissionEntry[] | undefined):
  | { readonly op: "list"; readonly prefix: string }
  | { readonly op: "get"; readonly key: string }
  | undefined {
  const kv = (permissions ?? []).filter((permission) => permission.service === "tinycloud.kv" || permission.service === "kv");
  const list = kv.find((permission) => hasKvAction(permission, "list"));
  if (list) return { op: "list", prefix: list.path };
  const get = kv.find((permission) => hasKvAction(permission, "get"));
  if (!get) return undefined;
  // A grant on one key is read as that key; a prefix grant is read at a key that does not exist (a hosted space answers 404 "key not found").
  return { op: "get", key: get.path === "" || get.path.endsWith("/") ? `${get.path}.tinycloud-space-probe` : get.path };
}

const UNHOSTED = /space not found/i;

/**
 * The production probe: one kv read with the session this login just saved,
 * inside the scope the owner approved. Only the unhosted 404 means
 * `unhosted`; success and a plain missing key mean `hosted`; any other
 * failure (denied, network) means `unknown`.
 */
export function kvSpaceProbe(
  ctx: ProfileSessionContext,
  permissions: readonly PermissionEntry[] | undefined,
  restore: (ctx: ProfileSessionContext) => Promise<ProfileSessionRestore> = restoreProfileSessionNode,
): () => Promise<SpaceProbeResult> {
  const target = readTarget(permissions);
  let restored: ProfileSessionRestore | undefined;
  return async () => {
    if (!target) return "unknown";
    restored ??= await restore(ctx);
    if ("unavailable" in restored) return "unknown";
    const kv = restored.node.kv;
    const result = target.op === "list"
      ? await kv.list({ prefix: target.prefix, limit: 1 })
      : await kv.get(target.key);
    if (result.ok) return "hosted";
    const status = (result.error.meta as { status?: number } | undefined)?.status;
    if (status === 404 && UNHOSTED.test(result.error.message)) return "unhosted";
    return result.error.code === "KV_NOT_FOUND" || status === 404 ? "hosted" : "unknown";
  };
}

/**
 * After a login saved its session: wait for, or report, OpenKey's space setup
 * as the relayed delegation described it. A no-op unless the delegation says
 * the space is not ready.
 */
export async function ensureSpaceSetup(
  ctx: ProfileSessionContext,
  delegation: Record<string, unknown>,
  permissions: readonly PermissionEntry[] | undefined,
): Promise<void> {
  const report = spaceSetupReport(delegation);
  if (!report) return;
  await awaitSpaceSetup(report, { probe: kvSpaceProbe(ctx, permissions) });
}
