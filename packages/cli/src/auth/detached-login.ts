import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { namedProfilePath, tinycloudHomePath } from "@tinycloud/operations/state";
import { ExitCode } from "../config/constants.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, readJson, writeJson } from "../config/storage.js";
import { CLIError, wrapError } from "../output/errors.js";
// Loaded only in the listener process, so code that imports this module (auth.ts and its test mocks) doesn't load it.
import type { callbackFlow } from "./browser-auth.js";

/**
 * `auth login --detach` and `auth status --wait`: the browser (localhost
 * callback) sign-in for agents whose shell commands are one-shot and time out.
 *
 * `--detach` starts the ordinary callback login in a detached child process
 * and returns as soon as the child prints the OpenKey link. The child keeps
 * the 127.0.0.1 listener open for up to 10 minutes; when OpenKey posts the
 * signed delegation, it runs the same verification and commit as a foreground
 * login (the proof must be signed for this profile's own key, TC-1053/TC-1422)
 * and records the outcome. `auth status --wait <s>` polls that record and the
 * profile's session, so an agent can wait in short calls.
 *
 * Nothing here relaxes the foreground login: the listener binds 127.0.0.1 on
 * a random port, accepts one POST on an unguessable path from OpenKey's origin,
 * and the delegation it receives is only stored after it verifies against the
 * profile's key. The record holds the approval link and the outcome, never a
 * key or a session; it lives beside the profiles, owner-only (0600 in 0700).
 */

/** How long the detached listener waits for the owner's approval. */
export const DETACHED_LOGIN_DEADLINE_MS = 10 * 60 * 1000;
/** Longest `auth status --wait`. */
export const MAX_LOGIN_WAIT_SECONDS = 600;
/** How long `--detach` waits for the child to print the link. */
const LISTENER_START_TIMEOUT_MS = 60_000;
const POLL_MS = 500;
/** How often the listener checks whether the profile was signed in another way. */
const SUPERSEDE_POLL_MS = 2_000;
/** After the deadline, how long a record may still say "waiting" before it counts as timed out. */
const DEADLINE_GRACE_MS = 5_000;

/** `superseded`: the profile got a new session another way (the paste fallback), so the listener stopped. */
export type DetachedLoginState = "starting" | "waiting" | "authenticated" | "failed" | "superseded";

export interface DetachedLoginError {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
}

export interface DetachedLoginRecord {
  readonly v: 1;
  readonly profile: string;
  /** The listener process. */
  readonly pid: number;
  readonly state: DetachedLoginState;
  /** Hash of what the login asks for (profile, host, permissions, expiry, owner). */
  readonly fingerprint: string;
  readonly startedAt: string;
  /** When the listener stops waiting. */
  readonly expiresAt: string;
  /** The profile's session (delegation CID) before this login, so a later wait can tell the new one apart. */
  readonly sessionBefore: string | null;
  readonly approvalUrl?: string;
  /** The login's JSON result, as a foreground login prints it. */
  readonly result?: Record<string, unknown>;
  readonly error?: DetachedLoginError;
  readonly finishedAt?: string;
}

/** What `--detach` prints and `auth status` shows about a pending or finished login. */
export interface DetachedLoginSummary {
  readonly state: DetachedLoginState;
  readonly approvalUrl?: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** After approval: what the owner unchecked on OpenKey (empty when everything was granted). */
  readonly declined?: readonly unknown[];
  /** After approval: when the new session ends. */
  readonly sessionExpiresAt?: string;
}

type ParentMessage =
  | { readonly type: "waiting"; readonly profile: string; readonly login: DetachedLoginSummary; readonly reused: boolean }
  | { readonly type: "error"; readonly error: DetachedLoginError };

function loginsDir(): string {
  return join(tinycloudHomePath(), "logins");
}

/** Validated profile file name: the same rule as the profile store's directories. */
function profileFile(profile: string, extension: string): string {
  return join(loginsDir(), `${basename(namedProfilePath(profile))}.${extension}`);
}

export function detachedLoginPath(profile: string): string {
  return profileFile(profile, "json");
}

export function detachedLoginLogPath(profile: string): string {
  return profileFile(profile, "log");
}

async function ensureLoginsDir(): Promise<void> {
  await mkdir(loginsDir(), { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(loginsDir(), PRIVATE_DIR_MODE);
}

export async function readDetachedLogin(profile: string): Promise<DetachedLoginRecord | null> {
  const record = await readJson<DetachedLoginRecord>(detachedLoginPath(profile)).catch(() => null);
  if (record === null || typeof record !== "object" || record.v !== 1 || record.profile !== profile ||
    typeof record.pid !== "number" || typeof record.expiresAt !== "string") return null;
  return record;
}

async function writeDetachedLogin(record: DetachedLoginRecord): Promise<void> {
  await ensureLoginsDir();
  await writeJson(detachedLoginPath(record.profile), record);
}

/** Create the record only if none exists. */
async function createDetachedLogin(record: DetachedLoginRecord): Promise<boolean> {
  await ensureLoginsDir();
  let handle;
  try {
    handle = await open(detachedLoginPath(record.profile), "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A login still waiting for its approval: its listener is running and its deadline has not passed. */
export function isLiveDetachedLogin(record: DetachedLoginRecord, now = Date.now()): boolean {
  return (record.state === "starting" || record.state === "waiting") &&
    now < Date.parse(record.expiresAt) && isProcessAlive(record.pid);
}

export function summarizeDetachedLogin(record: DetachedLoginRecord): DetachedLoginSummary {
  return {
    state: record.state,
    // The link matters only while the listener waits for it.
    ...(record.approvalUrl === undefined || (record.state !== "waiting" && record.state !== "starting") ? {} : { approvalUrl: record.approvalUrl }),
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    ...(record.error === undefined ? {} : { error: { code: record.error.code, message: record.error.message } }),
    ...(record.state === "authenticated" && Array.isArray(record.result?.declined) ? { declined: record.result.declined } : {}),
    ...(record.state === "authenticated" && typeof record.result?.expiresAt === "string" ? { sessionExpiresAt: record.result.expiresAt } : {}),
  };
}

/** Identifies a stored session without exposing it: its delegation CID, else a hash. */
export function sessionFingerprint(session: Record<string, unknown> | null): string | null {
  if (session === null) return null;
  if (typeof session.delegationCid === "string" && session.delegationCid !== "") return session.delegationCid;
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}

export function requestFingerprint(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

/** The argv for the detached child: the same command without `--detach`. */
export function detachedChildArgv(argv: readonly string[]): string[] {
  return ["--quiet", ...argv.filter((arg) => arg !== "--detach"), "--detached-child"];
}

function sendToParent(message: ParentMessage): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send !== "function" || process.connected === false) return resolve();
    const timer = setTimeout(resolve, 1_000);
    try {
      process.send(message, undefined, {}, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function asLoginError(error: unknown): DetachedLoginError {
  const cliError = wrapError(error);
  return { code: cliError.code, message: cliError.message, exitCode: cliError.exitCode };
}

let reportedToParent = false;

/** For errors the login command hits before the child takes its record: tell the parent once. */
export async function reportDetachedChildFailure(error: unknown): Promise<void> {
  if (reportedToParent) return;
  reportedToParent = true;
  await sendToParent({ type: "error", error: asLoginError(error) });
  if (process.connected) process.disconnect?.();
}

export interface DetachedChildParams {
  readonly profile: string;
  readonly fingerprint: string;
  readonly sessionBefore: string | null;
  /**
   * Run the foreground login with this acquisition (a callback flow that
   * reports its link and never prompts) and return its JSON result.
   */
  readonly run: (acquisition: typeof callbackFlow) => Promise<Record<string, unknown>>;
  /** The profile's current session fingerprint; a change while waiting means it was signed in another way. */
  readonly readSessionFingerprint?: () => Promise<string | null>;
  /** Test seam. */
  readonly deadlineMs?: number;
}

/**
 * The detached child: claim the profile's record, run the callback login, and
 * record the outcome. Returns the exit code. Requires the IPC channel that
 * `launchDetachedLogin` opens.
 */
export async function runDetachedLoginChild(params: DetachedChildParams): Promise<number> {
  if (typeof process.send !== "function") {
    throw new CLIError("INVALID_ARGUMENT", "--detached-child is internal to `auth login --detach`.", ExitCode.USAGE_ERROR);
  }
  const deadlineMs = params.deadlineMs ?? DETACHED_LOGIN_DEADLINE_MS;
  const startedAt = new Date();
  let record: DetachedLoginRecord = {
    v: 1,
    profile: params.profile,
    pid: process.pid,
    state: "starting",
    fingerprint: params.fingerprint,
    startedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
    sessionBefore: params.sessionBefore,
  };

  for (let attempt = 0; ; attempt += 1) {
    if (await createDetachedLogin(record)) break;
    const existing = await readDetachedLogin(params.profile);
    if (existing !== null && isLiveDetachedLogin(existing)) {
      reportedToParent = true;
      if (existing.fingerprint !== params.fingerprint) {
        await sendToParent({ type: "error", error: {
          code: "LOGIN_PENDING",
          message: `Another sign-in for profile "${params.profile}" is waiting for approval until ${existing.expiresAt}. Approve or let it expire, or check it with \`${CLI_NAME} --profile ${params.profile} auth status --wait 0\`.`,
          exitCode: ExitCode.ERROR,
        } });
        return ExitCode.ERROR;
      }
      // The same request again (an agent retrying): hand back the link that is already waiting.
      const ready = await waitForApprovalUrl(params.profile);
      if (ready === null) {
        await sendToParent({ type: "error", error: { code: "LOGIN_PENDING", message: "A sign-in for this profile is starting; run the command again in a few seconds.", exitCode: ExitCode.ERROR } });
        return ExitCode.ERROR;
      }
      await sendToParent({ type: "waiting", profile: params.profile, login: summarizeDetachedLogin(ready), reused: true });
      return ExitCode.SUCCESS;
    }
    if (attempt > 0) throw new CLIError("LOGIN_PENDING", "Could not claim the sign-in record for this profile.", ExitCode.ERROR);
    // A finished, expired or abandoned login: replace it.
    await rm(detachedLoginPath(params.profile), { force: true });
  }

  const { callbackFlow: listen } = await import("./browser-auth.js");
  let announced: Promise<void> | undefined;
  // A code pasted into `auth login --paste` meanwhile (OpenKey couldn't reach this listener) signs the profile in
  // without it: stop listening then, instead of holding the port until the deadline.
  const superseded = new AbortController();
  const watch = params.readSessionFingerprint === undefined ? undefined : setInterval(() => {
    void params.readSessionFingerprint!().then((current) => {
      if (current !== null && current !== params.sessionBefore) {
        superseded.abort(new CLIError("LOGIN_SUPERSEDED", "The profile was signed in another way; the listener stopped.", ExitCode.SUCCESS));
      }
    }, () => undefined);
  }, SUPERSEDE_POLL_MS);
  const acquisition: typeof callbackFlow = (did, options = {}) => listen(did, { ...options, noPopup: true }, {
    interactive: false,
    jsonOutput: true,
    deadlineMs,
    signal: superseded.signal,
    timeoutMessage: `No approval arrived within ${Math.round(deadlineMs / 60_000)} minutes; the sign-in listener stopped. Start the sign-in again.`,
    onApprovalUrl: (approvalUrl) => {
      record = { ...record, state: "waiting", approvalUrl };
      announced = writeDetachedLogin(record).then(async () => {
        reportedToParent = true;
        await sendToParent({ type: "waiting", profile: params.profile, login: summarizeDetachedLogin(record), reused: false });
        // The parent has what it needs; from here the child runs on its own.
        if (process.connected) process.disconnect?.();
      });
    },
  }).finally(() => clearInterval(watch));

  try {
    const result = await params.run(acquisition);
    await announced;
    record = { ...record, state: "authenticated", result, finishedAt: new Date().toISOString() };
    await writeDetachedLogin(record);
    return ExitCode.SUCCESS;
  } catch (error) {
    await announced?.catch(() => undefined);
    const failure = asLoginError(error);
    if (failure.code === "LOGIN_SUPERSEDED") {
      record = { ...record, state: "superseded", finishedAt: new Date().toISOString() };
      await writeDetachedLogin(record).catch(() => undefined);
      return ExitCode.SUCCESS;
    }
    record = { ...record, state: "failed", error: failure, finishedAt: new Date().toISOString() };
    await writeDetachedLogin(record).catch(() => undefined);
    if (!reportedToParent) {
      reportedToParent = true;
      await sendToParent({ type: "error", error: failure });
    }
    return failure.exitCode;
  } finally {
    clearInterval(watch);
    if (process.connected) process.disconnect?.();
  }
}

async function waitForApprovalUrl(profile: string, timeoutMs = 10_000): Promise<DetachedLoginRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readDetachedLogin(profile);
    if (record?.approvalUrl !== undefined && isLiveDetachedLogin(record)) return record;
    if (record === null || !isLiveDetachedLogin(record) || Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface LaunchedDetachedLogin {
  readonly profile: string;
  readonly login: DetachedLoginSummary;
  /** The same request was already waiting; its link is returned and no new listener started. */
  readonly reused: boolean;
}

/**
 * Start `entry` (a TinyCloud CLI script) with `argv` in a detached child and
 * return once it has printed the approval link. Its output goes to the
 * profile's login log; it keeps running after this process exits.
 */
export async function launchDetachedLogin(params: {
  readonly profile: string;
  readonly entry: string;
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly startTimeoutMs?: number;
}): Promise<LaunchedDetachedLogin> {
  await ensureLoginsDir();
  const logPath = detachedLoginLogPath(params.profile);
  const log = openSync(logPath, "w", PRIVATE_FILE_MODE);
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, params.entry, ...params.argv], {
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
      env: params.env ?? process.env,
    });
  } finally {
    closeSync(log);
  }

  const message = await new Promise<ParentMessage | { type: "exit"; code: number | null } | { type: "timeout" }>((resolve) => {
    const timer = setTimeout(() => resolve({ type: "timeout" }), params.startTimeoutMs ?? LISTENER_START_TIMEOUT_MS);
    child.once("message", (value) => {
      clearTimeout(timer);
      resolve(value as ParentMessage);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ type: "exit", code });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ type: "exit", code: null });
    });
  });
  if (child.connected) child.disconnect();
  child.unref();

  switch (message.type) {
    case "waiting":
      return { profile: message.profile, login: message.login, reused: message.reused };
    case "error":
      throw new CLIError(message.error.code, message.error.message, message.error.exitCode);
    case "timeout":
      child.kill();
      throw new CLIError("LOGIN_LISTENER_FAILED", `The sign-in listener did not start within ${Math.round((params.startTimeoutMs ?? LISTENER_START_TIMEOUT_MS) / 1000)} s; see ${logPath}.`, ExitCode.ERROR);
    default: {
      const tail = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").slice(-5).join(" ").slice(-600);
      throw new CLIError("LOGIN_LISTENER_FAILED", `The sign-in listener exited (code ${message.code ?? "unknown"}) before it was ready.${tail ? ` ${tail}` : ""}`, ExitCode.ERROR);
    }
  }
}

export type LoginWaitOutcome =
  | { readonly outcome: "authenticated"; readonly record: DetachedLoginRecord | null }
  | { readonly outcome: "waiting"; readonly record: DetachedLoginRecord }
  | { readonly outcome: "failed"; readonly record: DetachedLoginRecord | null; readonly error: DetachedLoginError }
  | { readonly outcome: "none"; readonly record: DetachedLoginRecord | null };

/**
 * Wait up to `waitMs` for the profile's sign-in. `authenticated` once the
 * profile has a usable session that this login produced (or any usable session
 * when no login is pending); `failed` when the listener recorded a failure,
 * exited, or passed its deadline; `none` when nothing is pending and there is
 * no usable session; `waiting` when the time ran out first.
 */
export async function waitForLogin(params: {
  readonly profile: string;
  readonly waitMs: number;
  /** The profile's stored session and whether commands can use it now. */
  readonly readSession: () => Promise<{ session: Record<string, unknown> | null; usable: boolean }>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<LoginWaitOutcome> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + params.waitMs;
  for (;;) {
    const { session, usable } = await params.readSession();
    const record = await readDetachedLogin(params.profile);
    if (usable && (record === null || record.state === "authenticated" || sessionFingerprint(session) !== record.sessionBefore)) {
      return { outcome: "authenticated", record };
    }
    if (record?.state === "failed") {
      return { outcome: "failed", record, error: record.error ?? { code: "LOGIN_FAILED", message: "The sign-in failed.", exitCode: ExitCode.ERROR } };
    }
    if (record !== null && (record.state === "starting" || record.state === "waiting")) {
      if (!isProcessAlive(record.pid)) {
        return { outcome: "failed", record, error: {
          code: "LOGIN_LISTENER_EXITED",
          message: "The sign-in listener stopped before an approval arrived. If OpenKey showed a code, finish with `auth login --paste` and the same --manifest; otherwise start the sign-in again.",
          exitCode: ExitCode.AUTH_REQUIRED,
        } };
      }
      if (now() > Date.parse(record.expiresAt) + DEADLINE_GRACE_MS) {
        return { outcome: "failed", record, error: { code: "AUTH_TIMEOUT", message: "No approval arrived before the sign-in listener's deadline. Start the sign-in again.", exitCode: ExitCode.AUTH_REQUIRED } };
      }
    } else {
      // Nothing pending (or an earlier login finished) and no usable session.
      return { outcome: "none", record };
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: "waiting", record };
    await sleep(Math.min(POLL_MS, remaining));
  }
}

/** `--wait <seconds>`: a whole number from 0 to 600. */
export function parseWaitSeconds(raw: string): number {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > MAX_LOGIN_WAIT_SECONDS) {
    throw new CLIError("INVALID_ARGUMENT", `--wait takes whole seconds from 0 to ${MAX_LOGIN_WAIT_SECONDS}.`, ExitCode.USAGE_ERROR);
  }
  return Number(raw);
}
