/**
 * Self-update (TC-4276): stage an exact, verified version under the versions root, smoke-test it, then switch the
 * launcher's pointer atomically. Nothing a running process uses is ever rewritten: each version lives in its own
 * directory, and a version a live process leased is not pruned.
 *
 * Both the background updater (patch and minor releases on the user's channel, after a 6 h soak) and the manual
 * `tinycloud upgrade` run through here, under one cross-process lock.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../config/constants.js";
import { acquireLock, compareVersionStrings, selectUpdateVersion, type InstallKind } from "./auto-update.js";
import {
  lockedPackages,
  packageUrlPath,
  REGISTRY,
  VerificationError,
  verifyCliRelease,
  verifyStagedTree,
  type BundleVerifier,
  type ReleaseRegistry,
  type VerificationCode,
} from "./provenance.js";
import {
  activeVersion,
  CLI_PACKAGE,
  installedVersions,
  isVerified,
  isVersion,
  liveLeases,
  launchContext,
  markVerified,
  processAlive,
  readPackageVersion,
  readPointer,
  removePointer,
  versionsRoot,
  writeFileAtomic,
  writePointer,
  type Pointer,
} from "./versions.js";

/** The global install this process belongs to: the launcher's, when the launcher started a newer version. */
export function baseInstall(): BaseInstall & { root: string } {
  const context = launchContext();
  // Every bundle that includes this module sits in the package's dist/, so "../" is the package directory.
  const packageDir = context?.basePackageDir ?? fileURLToPath(new URL("../", import.meta.url));
  const version = context?.baseVersion ?? readPackageVersion(packageDir) ?? "0.0.0";
  return { version, packageDir, bin: join(packageDir, "bin", "tinycloud"), root: context?.root ?? versionsRoot() };
}

/** The CLI config (`config.json`), for its `autoUpdate` setting; undefined when missing or unreadable. */
export function readGlobalConfig(): unknown {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A release is installed automatically only once it has been the channel tag this long (Naomi, 24 Nov). */
export const SOAK_MS = 6 * HOUR_MS;
/** How long a foreground command waits before it may start another background check. */
const SPAWN_CLAIM_MS = 15 * 60 * 1000;
/** The first release with the launcher. An older version would run the old in-place `upgrade`. */
export const MIN_TARGET_VERSION = "1.9.4";

export type RefusalReason =
  | "UNSUPPORTED_INSTALL"
  | "NEEDS_YES"
  | "DECLINED"
  | "LOCKED"
  | "NPM_NOT_FOUND"
  | "INVALID_VERSION"
  | "VERSION_NOT_FOUND"
  | "TARGET_TOO_OLD"
  | "REGISTRY_UNAVAILABLE"
  | "COURIER_RUNNING"
  | VerificationCode;
export type FailureReason = "INSTALL_FAILED" | "SMOKE_FAILED" | "SWITCH_FAILED";

export type UpgradeResult =
  | { status: "ok"; from: string; to: string; changed: boolean; unattested?: string[] }
  | { status: "refused"; reason: RefusalReason; from: string; to?: string; detail?: string }
  | { status: "failed-rolled-back"; reason: FailureReason; from: string; to: string; current: string; detail?: string }
  | { status: "failed-not-rolled-back"; reason: FailureReason; from: string; to: string; detail?: string };

export type AutoOutcome =
  | { action: "none" | "locked" | "pinned" | "major-available"; version?: string }
  | { action: "soaking"; version: string; dueAt: number }
  | { action: "deferred"; version: string }
  | { action: "switched" | "followed-down"; version: string; from: string }
  | { action: "failed"; version: string; result: UpgradeResult };

export interface BaseInstall {
  /** The global package's version (the launcher's own build). */
  version: string;
  packageDir: string;
  /** The global launcher, `<packageDir>/bin/tinycloud`. */
  bin: string;
}

export interface UpdaterDeps {
  root: string;
  base: BaseInstall;
  now(): number;
  registry: ReleaseRegistry & { distTags(): Promise<Record<string, string>> };
  verifyBundle: BundleVerifier;
  /** `npm install` exactly `@tinycloud/cli@<version>` into `directory`, running no install scripts. */
  stage(directory: string, version: string): Promise<void>;
  /** Run `node <bin> ...args` with automatic updates off; resolve its exit code and stdout. */
  run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  log(line: string): void;
  alive?(pid: number): boolean;
}

interface UpdaterState {
  soak?: { channel: string; version: string; firstSeen: number };
  /** Staged and verified, waiting for Courier to stop. */
  pending?: string;
}

class UpdateStop extends Error {
  constructor(readonly result: UpgradeResult) {
    super(result.status);
  }
}

export function channelOf(version: string): string {
  return /^[^-+]+-([0-9A-Za-z-]+)/.exec(version)?.[1] ?? "latest";
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readState(root: string): UpdaterState {
  const value = readJson(join(root, "auto-update.json"));
  if (!value || typeof value !== "object") return {};
  const state: UpdaterState = {};
  if ("pending" in value && isVersion(value.pending)) state.pending = value.pending;
  if ("soak" in value && value.soak && typeof value.soak === "object") {
    const soak = value.soak;
    if ("channel" in soak && typeof soak.channel === "string" && "version" in soak && isVersion(soak.version) &&
        "firstSeen" in soak && typeof soak.firstSeen === "number" && Number.isFinite(soak.firstSeen)) {
      state.soak = { channel: soak.channel, version: soak.version, firstSeen: soak.firstSeen };
    }
  }
  return state;
}

function writeState(root: string, state: UpdaterState): void {
  writeFileAtomic(join(root, "auto-update.json"), `${JSON.stringify(state)}\n`);
}

function readNextCheck(root: string): number {
  const value = readJson(join(root, "next-check.json"));
  return value && typeof value === "object" && "at" in value && typeof value.at === "number" ? value.at : 0;
}

function writeNextCheck(root: string, at: number): void {
  writeFileAtomic(join(root, "next-check.json"), `${JSON.stringify({ at })}\n`);
}

function courierRunning(deps: UpdaterDeps, version: string): boolean {
  return liveLeases(deps.root, deps.alive ?? processAlive).some((lease) => lease.courier && lease.version === version);
}

function current(deps: UpdaterDeps): string {
  return activeVersion(deps.root, deps.base.packageDir, deps.base.version).version;
}

/** The pointer, when the launcher honours it for this global install. */
function livePointer(deps: UpdaterDeps): Pointer | null {
  const pointer = readPointer(deps.root);
  return pointer && pointer.base === deps.base.version && current(deps) === pointer.version ? pointer : null;
}

/**
 * Make `version` present and verified under the root: provenance and registry signatures first, then a script-free
 * npm install into a staging directory, the whole tree's signatures, and a smoke test of the staged copy alone.
 */
export async function prepareVersion(deps: UpdaterDeps, version: string, from: string): Promise<string[]> {
  if (version === deps.base.version || isVerified(deps.root, version)) return [];
  let manifest;
  try {
    manifest = await verifyCliRelease(deps.registry, deps.verifyBundle, version);
  } catch (error) {
    throw new UpdateStop(error instanceof VerificationError
      ? { status: "refused", reason: error.code, from, to: version, detail: error.message }
      : { status: "refused", reason: /\b404\b/.test(String((error as Error).message)) ? "VERSION_NOT_FOUND" : "REGISTRY_UNAVAILABLE", from, to: version });
  }
  mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  const staging = join(deps.root, `.staging-${version}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const failed = (reason: FailureReason, detail?: string) =>
    new UpdateStop({ status: "failed-rolled-back", reason, from, to: version, current: from, ...(detail ? { detail } : {}) });
  try {
    try {
      await deps.stage(staging, version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UpdateStop({ status: "refused", reason: "NPM_NOT_FOUND", from, to: version });
      throw failed("INSTALL_FAILED", (error as Error).message);
    }
    let unattested: string[];
    try {
      unattested = await verifyStagedTree(deps.registry, deps.verifyBundle, lockedPackages(readJson(join(staging, "package-lock.json"))), manifest);
    } catch (error) {
      if (error instanceof VerificationError) throw new UpdateStop({ status: "refused", reason: error.code, from, to: version, detail: error.message });
      throw new UpdateStop({ status: "refused", reason: "REGISTRY_UNAVAILABLE", from, to: version });
    }
    for (const id of unattested) deps.log(`${id} has no provenance attestation; its registry signature verified`);
    const packageDir = join(staging, "node_modules", "@tinycloud", "cli");
    if (!existsSync(join(packageDir, "dist", "launcher.js"))) throw new UpdateStop({ status: "refused", reason: "TARGET_TOO_OLD", from, to: version });
    const smoke = await deps.run(join(packageDir, "bin", "tinycloud"), ["--version"]);
    if (smoke.code !== 0 || smoke.stdout.trim() !== version) throw failed("SMOKE_FAILED", `staged --version printed ${JSON.stringify(smoke.stdout.trim())}`);
    // The bundled Courier is a separate lazily loaded entry; it has to load too.
    const courier = await deps.run(join(packageDir, "bin", "tinycloud"), ["courier", "--version"]);
    if (courier.code !== 0) throw failed("SMOKE_FAILED", `staged courier --version exited ${courier.code}`);
    markVerified(staging, version, manifest.dist.integrity);
    const final = join(deps.root, version);
    if (existsSync(final)) discard(deps.root, final);
    renameSync(staging, final);
    return unattested;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Move a directory out of the way in one rename, then delete it: no reader ever sees half a version. */
function discard(root: string, directory: string): void {
  const trash = join(root, `.trash-${process.pid}-${Math.random().toString(36).slice(2)}`);
  renameSync(directory, trash);
  rmSync(trash, { recursive: true, force: true });
}

/** Point the launcher at `version`, check it through the real launcher, and restore the previous pointer if not. */
export async function switchTo(deps: UpdaterDeps, version: string, flags: { auto: boolean; pinned: boolean }): Promise<UpgradeResult> {
  const from = current(deps);
  const before = readPointer(deps.root);
  const failure = (detail: string): Promise<UpgradeResult> => restore(deps, before, from, version, detail);
  try {
    writePointer(deps.root, { version, base: deps.base.version, ...flags, ...(from !== version ? { previous: from } : before?.previous ? { previous: before.previous } : {}) });
  } catch (error) {
    return failure((error as Error).message);
  }
  const check = await deps.run(deps.base.bin, ["--version"]);
  if (check.code !== 0 || check.stdout.trim() !== version) return failure(`tinycloud --version printed ${JSON.stringify(check.stdout.trim())}`);
  return { status: "ok", from, to: version, changed: from !== version };
}

async function restore(deps: UpdaterDeps, before: Pointer | null, from: string, to: string, detail: string): Promise<UpgradeResult> {
  try {
    if (before) writePointer(deps.root, before);
    else removePointer(deps.root);
    const check = await deps.run(deps.base.bin, ["--version"]);
    if (check.code === 0 && check.stdout.trim() === from) return { status: "failed-rolled-back", reason: "SWITCH_FAILED", from, to, current: from, detail };
  } catch {
    // Reported below.
  }
  return { status: "failed-not-rolled-back", reason: "SWITCH_FAILED", from, to, detail };
}

/** Delete versions no pointer, global install or live process uses, plus leftovers of interrupted runs. Lock held. */
export function prune(deps: UpdaterDeps): void {
  const pointer = readPointer(deps.root);
  const keep = new Set([deps.base.version, current(deps), pointer?.version, pointer?.previous, readState(deps.root).pending]);
  for (const lease of liveLeases(deps.root, deps.alive ?? processAlive)) keep.add(lease.version);
  for (const version of installedVersions(deps.root)) {
    if (!keep.has(version)) discard(deps.root, join(deps.root, version));
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(deps.root);
  } catch {
    // No root, nothing left over.
  }
  for (const leftover of entries) {
    if (leftover.startsWith(".staging-") || leftover.startsWith(".trash-")) rmSync(join(deps.root, leftover), { recursive: true, force: true });
  }
}

async function withLock<T>(root: string, locked: () => Promise<T>, busy: () => T): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = await acquireLock(join(root, ".update-lock"));
  if (!release) return busy();
  try {
    return await locked();
  } finally {
    await release();
  }
}

/** The background updater: one pass, under the lock. */
export async function runAutoUpdate(deps: UpdaterDeps): Promise<AutoOutcome> {
  return withLock(deps.root, () => autoUpdateLocked(deps), () => ({ action: "locked" }));
}

async function autoUpdateLocked(deps: UpdaterDeps): Promise<AutoOutcome> {
  const now = deps.now();
  const state = readState(deps.root);
  const next = (at: number) => writeNextCheck(deps.root, at);
  const pointer = livePointer(deps);
  const active = current(deps);
  if (pointer?.pinned) {
    next(now + DAY_MS);
    return { action: "pinned", version: active };
  }

  let tags: Record<string, string>;
  try {
    tags = await deps.registry.distTags();
  } catch (error) {
    deps.log(`dist-tags unavailable: ${(error as Error).message}`);
    next(now + HOUR_MS);
    return { action: "none" };
  }
  const channel = channelOf(active);
  const tag = tags[channel];
  let target: string | undefined;
  let followDown = false;
  // The tag decides every pass: a version deferred for Courier earlier is switched to only while it is still the
  // target, and is already verified by then, so preparing it again costs nothing.
  if (isVersion(tag) && selectUpdateVersion(active, { [channel]: tag }) === tag) {
    if (majorOf(tag) !== majorOf(active)) {
      next(now + DAY_MS);
      return { action: "major-available", version: tag };
    }
    if (state.soak?.channel !== channel || state.soak.version !== tag) state.soak = { channel, version: tag, firstSeen: now };
    const dueAt = state.soak.firstSeen + SOAK_MS;
    if (now < dueAt) {
      writeState(deps.root, state);
      next(dueAt);
      return { action: "soaking", version: tag, dueAt };
    }
    target = tag;
  } else if (isVersion(tag) && pointer?.auto && channelOf(tag) === channel && majorOf(tag) === majorOf(active) &&
             (compareVersionStrings(tag, active) ?? 0) < 0) {
    target = tag;
    followDown = true;
  } else {
    writeState(deps.root, {});
    next(now + DAY_MS);
    return { action: "none" };
  }

  try {
    await prepareVersion(deps, target, active);
  } catch (error) {
    if (!(error instanceof UpdateStop)) throw error;
    deps.log(`${target}: ${error.result.status}${"reason" in error.result ? ` ${error.result.reason}` : ""}${"detail" in error.result && error.result.detail ? `: ${error.result.detail}` : ""}`);
    writeState(deps.root, { ...state, pending: undefined });
    next(now + DAY_MS);
    return { action: "failed", version: target, result: error.result };
  }
  if (courierRunning(deps, active)) {
    writeState(deps.root, { ...state, pending: target });
    next(now + HOUR_MS);
    deps.log(`${target} is verified; switching waits for Courier (running ${active}) to stop`);
    return { action: "deferred", version: target };
  }
  const result = await switchTo(deps, target, { auto: true, pinned: false });
  writeState(deps.root, {});
  next(now + DAY_MS);
  if (result.status !== "ok") {
    deps.log(`${target}: ${result.status} ${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
    return { action: "failed", version: target, result };
  }
  prune(deps);
  deps.log(`${followDown ? "followed the tag down" : "switched"} ${active} -> ${target}`);
  return { action: followDown ? "followed-down" : "switched", version: target, from: active };
}

export interface ManualOptions {
  installKind: InstallKind;
  to?: string;
  /** Ask the user; resolves true to go ahead. Not called with `--yes`. */
  confirm?: (from: string, to: string) => Promise<boolean>;
}

/** `tinycloud upgrade`: no soak, majors allowed, `--to` pins (and may go down). */
export async function runManualUpgrade(deps: UpdaterDeps, options: ManualOptions): Promise<UpgradeResult> {
  const from = current(deps);
  if (options.installKind !== "npm-global" && options.installKind !== "bun-global") return { status: "refused", reason: "UNSUPPORTED_INSTALL", from };
  if (options.to !== undefined && !isVersion(options.to)) return { status: "refused", reason: "INVALID_VERSION", from, to: options.to };
  if (options.to !== undefined && (compareVersionStrings(options.to, MIN_TARGET_VERSION) ?? -1) < 0) {
    return { status: "refused", reason: "TARGET_TOO_OLD", from, to: options.to };
  }
  return withLock(deps.root, async () => {
    try {
      return await manualLocked(deps, options, from);
    } catch (error) {
      if (error instanceof UpdateStop) return error.result;
      throw error;
    }
  }, () => ({ status: "refused", reason: "LOCKED", from }));
}

async function manualLocked(deps: UpdaterDeps, options: ManualOptions, from: string): Promise<UpgradeResult> {
  const pointer = livePointer(deps);
  let target = options.to;
  if (target === undefined) {
    let tags: Record<string, string>;
    try {
      tags = await deps.registry.distTags();
    } catch {
      return { status: "refused", reason: "REGISTRY_UNAVAILABLE", from };
    }
    const channel = channelOf(from);
    const tag = tags[channel];
    if (!isVersion(tag) || selectUpdateVersion(from, { [channel]: tag }) !== tag) {
      // Already current. A plain `upgrade` also ends a `--to` pin.
      if (pointer?.pinned) writePointer(deps.root, { ...pointer, pinned: false });
      return { status: "ok", from, to: from, changed: false };
    }
    target = tag;
  }
  if (target === from) {
    if (options.to !== undefined) writePointer(deps.root, { version: from, base: deps.base.version, auto: false, pinned: true, ...(pointer?.previous ? { previous: pointer.previous } : {}) });
    return { status: "ok", from, to: from, changed: false };
  }
  if (options.confirm && !await options.confirm(from, target)) return { status: "refused", reason: "DECLINED", from, to: target };
  const unattested = await prepareVersion(deps, target, from);
  if (courierRunning(deps, from)) return { status: "refused", reason: "COURIER_RUNNING", from, to: target };
  const result = await switchTo(deps, target, { auto: false, pinned: options.to !== undefined });
  if (result.status === "ok") {
    writeState(deps.root, {});
    prune(deps);
    return unattested.length > 0 ? { ...result, unattested } : result;
  }
  return result;
}

/** Why automatic updates are off, or null when they are on. The notice and manual `upgrade` work either way. */
export function autoUpdateOffReason(env: NodeJS.ProcessEnv, config: unknown, home: string = homedir()): "env" | "ci" | "config" | "sandbox" | null {
  if (env.TC_NO_AUTO_UPDATE === "1") return "env";
  if (env.CI) return "ci";
  if (config && typeof config === "object" && "autoUpdate" in config && config.autoUpdate === false) return "config";
  if (env.TC_HOME && resolve(env.TC_HOME) !== join(home, ".tinycloud") && !env.TC_VERSIONS_DIR) return "sandbox";
  return null;
}

/**
 * Called after a foreground command: start the background updater if a check is due. A claim written first keeps
 * parallel commands from starting more than one; the updater's lock covers the rest.
 */
export function startAutoUpdateIfDue(root: string, now: number, startJob: () => void): boolean {
  if (readNextCheck(root) > now) return false;
  try {
    writeNextCheck(root, now + SPAWN_CLAIM_MS);
  } catch {
    return false;
  }
  startJob();
  return true;
}

/** A verified version waiting only for Courier to stop, for the foreground notice. */
export function pendingSwitch(root: string, active: string): string | null {
  const pending = readState(root).pending;
  return pending && pending !== active && isVerified(root, pending) ? pending : null;
}

export function appendUpdateLog(root: string, line: string, now: Date = new Date()): void {
  const file = join(root, "auto-update.log");
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (existsSync(file) && statSync(file).size > 256 * 1024) truncateSync(file, 0);
    appendFileSync(file, `${now.toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // The log is best effort.
  }
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve: done, reject } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  child.on("error", reject);
  child.on("close", (code) => done({ code, stdout, stderr }));
  return promise;
}

/** The real registry, npm and node behind `UpdaterDeps`. */
export function productionDeps(root: string, base: BaseInstall, registry: ReleaseRegistry, verifyBundle: BundleVerifier, log: (line: string) => void): UpdaterDeps {
  return {
    root,
    base,
    now: Date.now,
    registry: {
      ...registry,
      async distTags() {
        const response = await fetch(`${REGISTRY}/-/package/${packageUrlPath(CLI_PACKAGE)}/dist-tags`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`dist-tags returned ${response.status}`);
        const tags: unknown = await response.json();
        if (!tags || typeof tags !== "object") throw new Error("dist-tags unreadable");
        return Object.fromEntries(Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      },
    },
    verifyBundle,
    async stage(directory, version) {
      const result = await runProcess("npm", [
        "install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--registry", `${REGISTRY}/`, `${CLI_PACKAGE}@${version}`,
      ], process.env, 15 * 60 * 1000);
      if (result.code !== 0) throw new Error(`npm install exited ${result.code}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
    },
    async run(bin, args) {
      const { code, stdout } = await runProcess(process.execPath, [bin, ...args], { ...process.env, TC_NO_AUTO_UPDATE: "1" }, 120_000);
      return { code, stdout };
    },
    log,
  };
}

