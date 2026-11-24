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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../config/constants.js";
import { checkForUpdate, compareVersionStrings, isAutoUpdateEnabled, selectUpdateVersion, type InstallKind } from "./auto-update.js";
import { acquireInstallLock, type InstallLock } from "./install-lock.js";
import { bunGlobalModules, recordInstallKind, verifyInstallKind, type GlobalRoots } from "./install-kind.js";
import { resolveNpm } from "./npm-command.js";
import {
  checkResolvedAgainstShrinkwrap,
  lockedPackages,
  npmRegistry,
  packageUrlPath,
  REGISTRY,
  releaseShrinkwrap,
  sigstoreVerifier,
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
/**
 * The first launcher-capable release (with its npm-shrinkwrap.json); an older version would run the old in-place
 * `upgrade`. This must move if the launcher release ships under another version.
 */
export const MIN_TARGET_VERSION = "1.10.0";

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
  /**
   * Write a `package.json` depending on exactly `@tinycloud/cli@<version>` in `directory` and resolve its
   * `package-lock.json` (`npm install --package-lock-only --ignore-scripts`): no dependency is downloaded or run.
   */
  resolve(directory: string, version: string): Promise<void>;
  /** Install exactly `directory`'s `package-lock.json` (`npm ci --ignore-scripts`). */
  install(directory: string): Promise<void>;
  /** Run `node <bin> ...args` with automatic updates off; resolve its exit code and stdout. */
  run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  log(line: string): void;
  alive?(pid: number): boolean;
  /** The install lock this pass holds; set by `withLock`. */
  lock?: InstallLock;
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
 * Make `version` present and verified under the root. Nothing is downloaded by npm, and no package code runs, until
 * every package is verified:
 * 1. the CLI release's registry signature and provenance;
 * 2. its tarball's `npm-shrinkwrap.json`: every runtime dependency must be a registry tarball (a git, file, link or
 *    URL dependency refuses with DEPENDENCY_NOT_FROM_REGISTRY; npm runs a git dependency's `prepare` script even
 *    under `--ignore-scripts`, so it must never reach npm);
 * 3. a lockfile-only npm resolve in a staging directory, which must equal the shrinkwrap plus the CLI;
 * 4. every locked package's registry signature, and provenance for `@tinycloud/*`;
 * 5. `npm ci --ignore-scripts` of exactly that lockfile, then a check that what was installed is what was locked;
 * 6. a smoke test of the staged copy alone.
 */
export async function prepareVersion(deps: UpdaterDeps, version: string, from: string): Promise<string[]> {
  if (version === deps.base.version || isVerified(deps.root, version)) return [];
  const refused = (error: unknown) => new UpdateStop(error instanceof VerificationError
    ? { status: "refused", reason: error.code, from, to: version, detail: error.message }
    : { status: "refused", reason: /\b404\b/.test(String((error as Error).message)) ? "VERSION_NOT_FOUND" : "REGISTRY_UNAVAILABLE", from, to: version });
  let manifest;
  let shrinkwrap;
  try {
    manifest = await verifyCliRelease(deps.registry, deps.verifyBundle, version);
    shrinkwrap = await releaseShrinkwrap(deps.registry, manifest);
  } catch (error) {
    throw refused(error);
  }
  // Every launcher-capable release (MIN_TARGET_VERSION and later) ships its shrinkwrap.
  if (!shrinkwrap) throw new UpdateStop({ status: "refused", reason: "TARGET_TOO_OLD", from, to: version, detail: "the release has no npm-shrinkwrap.json" });
  mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  const staging = join(deps.root, `.staging-${version}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const failed = (reason: FailureReason, detail?: string) =>
    new UpdateStop({ status: "failed-rolled-back", reason, from, to: version, current: from, ...(detail ? { detail } : {}) });
  const npmStep = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UpdateStop({ status: "refused", reason: "NPM_NOT_FOUND", from, to: version });
      throw failed("INSTALL_FAILED", (error as Error).message);
    }
  };
  try {
    mkdirSync(staging, { mode: 0o700 });
    await npmStep(() => deps.resolve(staging, version));
    const lockfile = readJson(join(staging, "package-lock.json"));
    let unattested: string[];
    try {
      const locked = lockedPackages(lockfile);
      checkResolvedAgainstShrinkwrap(locked, shrinkwrap, manifest);
      unattested = await verifyStagedTree(deps.registry, deps.verifyBundle, locked, manifest);
    } catch (error) {
      throw refused(error);
    }
    for (const id of unattested) deps.log(`${id} has no provenance attestation; its registry signature verified`);
    await npmStep(() => deps.install(staging));
    const mismatch = installedTreeMismatch(staging, lockfile);
    if (mismatch) throw failed("INSTALL_FAILED", mismatch);
    const packageDir = join(staging, "node_modules", "@tinycloud", "cli");
    if (!existsSync(join(packageDir, "dist", "launcher.js"))) throw new UpdateStop({ status: "refused", reason: "TARGET_TOO_OLD", from, to: version });
    const smoke = await deps.run(join(packageDir, "bin", "tinycloud"), ["--version"]);
    if (smoke.code !== 0 || smoke.stdout.trim() !== version) throw failed("SMOKE_FAILED", `staged --version printed ${JSON.stringify(smoke.stdout.trim())}`);
    // The bundled Courier is a separate lazily loaded entry; it has to load too.
    const courier = await deps.run(join(packageDir, "bin", "tinycloud"), ["courier", "--version"]);
    if (courier.code !== 0) throw failed("SMOKE_FAILED", `staged courier --version exited ${courier.code}`);
    markVerified(staging, version, manifest.dist.integrity);
    const final = join(deps.root, version);
    if (!holdsLock(deps)) throw new UpdateStop({ status: "refused", reason: "LOCKED", from, to: version });
    if (existsSync(final)) discard(deps.root, final);
    renameSync(staging, final);
    return unattested;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Why the tree `npm ci` installed in `directory` isn't exactly `lockfile`, or null when it is: every locked package
 * present with its name and version (an optional one may be skipped on this platform), and npm's own record of the
 * install (`node_modules/.package-lock.json`) naming nothing else.
 */
export function installedTreeMismatch(directory: string, lockfile: unknown): string | null {
  const locked = (lockfile as { packages?: Record<string, Record<string, unknown>> } | undefined)?.packages ?? {};
  const hidden = readJson(join(directory, "node_modules", ".package-lock.json"));
  const installed = hidden && typeof hidden === "object" && "packages" in hidden && hidden.packages && typeof hidden.packages === "object"
    ? Object.keys(hidden.packages)
    : null;
  if (!installed) return "npm left no record of the install";
  const extra = installed.filter((path) => !(path in locked) || locked[path]?.dev === true);
  if (extra.length > 0) return `installed ${extra[0]}, which the verified lockfile doesn't hold`;
  for (const [path, entry] of Object.entries(locked)) {
    if (path === "" || entry.dev === true || entry.inBundle === true) continue;
    const name = typeof entry.name === "string" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const manifest = readJson(join(directory, path, "package.json"));
    if (manifest === undefined && entry.optional === true && !installed.includes(path)) continue;
    const got = manifest && typeof manifest === "object" && "name" in manifest && "version" in manifest ? `${String(manifest.name)}@${String(manifest.version)}` : "nothing";
    if (got !== `${name}@${String(entry.version)}`) return `${path} holds ${got}, not the verified ${name}@${String(entry.version)}`;
  }
  return null;
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
  if (!holdsLock(deps)) return { status: "refused", reason: "LOCKED", from, to: version };
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
    // Lost the lock: another updater may be switching now, so the pointer is left to it.
    if (!holdsLock(deps)) return { status: "failed-not-rolled-back", reason: "SWITCH_FAILED", from, to, detail };
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
  if (!holdsLock(deps)) return;
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

async function withLock<T>(deps: UpdaterDeps, locked: (deps: UpdaterDeps) => Promise<T>, busy: () => T): Promise<T> {
  mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  const lock = acquireInstallLock(deps.root, deps.alive ? { alive: deps.alive } : {});
  if (!lock) return busy();
  try {
    return await locked({ ...deps, lock });
  } finally {
    lock.release();
  }
}

/** False once this pass lost the install lock (it ran into the lock's age cap): it must change nothing more. */
function holdsLock(deps: UpdaterDeps): boolean {
  return deps.lock === undefined || deps.lock.valid();
}

/** The background updater: one pass, under the lock. */
export async function runAutoUpdate(deps: UpdaterDeps): Promise<AutoOutcome> {
  return withLock<AutoOutcome>(deps, async (locked) => {
    const before = readPointer(locked.root);
    const from = current(locked);
    const attempt: { to?: string } = {};
    try {
      return await autoUpdateLocked(locked, attempt);
    } catch (error) {
      if (attempt.to === undefined) throw error;
      const result = await recoverFromUnexpected(locked, before, from, attempt.to, error);
      locked.log(`${attempt.to}: ${result.status}${"detail" in result && result.detail ? `: ${result.detail}` : ""}`);
      return { action: "failed", version: attempt.to, result };
    }
  }, () => ({ action: "locked" }));
}

/**
 * An unexpected error (not an `UpdateStop`) during an update. Before the pointer changed, nothing did: the error
 * propagates (`tinycloud upgrade` exits 1). After, the pointer is restored as after a failed switch, and the result
 * says whether that worked (exit 13 or 14).
 */
async function recoverFromUnexpected(deps: UpdaterDeps, before: Pointer | null, from: string, to: string | undefined, error: unknown): Promise<UpgradeResult> {
  if (to === undefined || JSON.stringify(readPointer(deps.root)) === JSON.stringify(before)) throw error;
  return restore(deps, before, from, to, error instanceof Error ? error.message : String(error));
}

/**
 * Whether a follow-down waits out the soak too (Naomi, TC-4276: yes, from the local first-seen of the lower tag).
 * One switch, so the rule is easy to change.
 */
const FOLLOW_DOWN_SOAKS = true;

async function autoUpdateLocked(deps: UpdaterDeps, attempt: { to?: string }): Promise<AutoOutcome> {
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
    target = tag;
  } else if (isVersion(tag) && pointer?.auto && channelOf(tag) === channel && majorOf(tag) === majorOf(active) &&
             (compareVersionStrings(tag, active) ?? 0) < 0 &&
             // Never below the version installed by hand: that's the floor the user chose.
             (compareVersionStrings(tag, deps.base.version) ?? -1) >= 0) {
    target = tag;
    followDown = true;
  } else {
    writeState(deps.root, {});
    next(now + DAY_MS);
    return { action: "none" };
  }
  if (!followDown || FOLLOW_DOWN_SOAKS) {
    if (state.soak?.channel !== channel || state.soak.version !== tag) state.soak = { channel, version: tag, firstSeen: now };
    const dueAt = state.soak.firstSeen + SOAK_MS;
    if (now < dueAt) {
      writeState(deps.root, state);
      next(dueAt);
      return { action: "soaking", version: tag, dueAt };
    }
  }
  attempt.to = target;

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
  writeFileAtomic(join(deps.root, LAST_SWITCH_FILE), `${JSON.stringify({ from: active, to: target, down: followDown })}\n`);
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
  return withLock<UpgradeResult>(deps, async (locked) => {
    const before = readPointer(locked.root);
    const attempt: { to?: string } = {};
    try {
      return await manualLocked(locked, options, from, attempt);
    } catch (error) {
      if (error instanceof UpdateStop) return error.result;
      return recoverFromUnexpected(locked, before, from, attempt.to, error);
    }
  }, () => ({ status: "refused", reason: "LOCKED", from }));
}

async function manualLocked(deps: UpdaterDeps, options: ManualOptions, from: string, attempt: { to?: string }): Promise<UpgradeResult> {
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
      if (pointer?.pinned && holdsLock(deps)) writePointer(deps.root, { ...pointer, pinned: false });
      return { status: "ok", from, to: from, changed: false };
    }
    target = tag;
  }
  if (target === from) {
    if (options.to !== undefined && holdsLock(deps)) writePointer(deps.root, { version: from, base: deps.base.version, auto: false, pinned: true, ...(pointer?.previous ? { previous: pointer.previous } : {}) });
    return { status: "ok", from, to: from, changed: false };
  }
  if (options.confirm && !await options.confirm(from, target)) return { status: "refused", reason: "DECLINED", from, to: target };
  attempt.to = target;
  const unattested = await prepareVersion(deps, target, from);
  if (courierRunning(deps, from)) return { status: "refused", reason: "COURIER_RUNNING", from, to: target };
  const result = await switchTo(deps, target, { auto: false, pinned: options.to !== undefined });
  if (result.status === "ok") {
    writeState(deps.root, {});
    // `upgrade` reports its own switch; an earlier automatic one is no longer news.
    rmSync(join(deps.root, LAST_SWITCH_FILE), { force: true });
    prune(deps);
    return unattested.length > 0 ? { ...result, unattested } : result;
  }
  return result;
}

/** Why automatic updates are off, or null when they are on. The notice and manual `upgrade` work either way. */
export function autoUpdateOffReason(env: NodeJS.ProcessEnv, config: unknown, home: string = homedir()): "env" | "ci" | "config" | "sandbox" | null {
  // The notice's rule (TC_NO_AUTO_UPDATE=1, or CI set to anything but false or 0), so the two can't drift.
  if (!isAutoUpdateEnabled(env)) return env.TC_NO_AUTO_UPDATE === "1" ? "env" : "ci";
  if (config && typeof config === "object" && "autoUpdate" in config && config.autoUpdate === false) return "config";
  // TC_HOME names a home directory (operations' tinycloudHomePath); another one is a sandbox, which shares this
  // machine's ~/.tinycloud/versions unless TC_VERSIONS_DIR gives it its own.
  if (env.TC_HOME && resolve(env.TC_HOME) !== resolve(home) && !env.TC_VERSIONS_DIR) return "sandbox";
  return null;
}

/**
 * Whether the background updater installs `available` itself, so the "update available" notice is left out
 * (Naomi, TC-4276): a patch or minor on the install's channel, for an npm or bun global install with auto-update
 * on, npm on PATH, and no pin. Majors, other channels, other installs and auto-update off keep the notice.
 */
export function autoUpdateCovers(input: {
  installKind: InstallKind;
  current: string;
  available: string;
  offReason: string | null;
  npmOnPath: boolean;
  pinned: boolean;
}): boolean {
  return (input.installKind === "npm-global" || input.installKind === "bun-global") &&
    input.offReason === null && input.npmOnPath && !input.pinned &&
    // The updater stays on the install's channel; #1054 may offer a beta install the higher `latest`.
    channelOf(input.available) === channelOf(input.current) && majorOf(input.available) === majorOf(input.current);
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

/**
 * Start the one detached background child of this run (TC-4276 on top of #1054's G1): #1054's update-check entry,
 * which with `--self-update` refreshes the notice cache and then runs one auto-update pass (`runBackgroundUpdate`).
 * `entryPath` is the global install's entry, so the pass belongs to that install, not to a versioned one.
 */
export function startBackgroundUpdate(entryPath: string, currentVersion: string, cachePath: string): void {
  const child = spawn(process.execPath, [entryPath, currentVersion, cachePath, "--self-update"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

/** The background child's work: #1054's update check (its dist-tags answer reused), then one auto-update pass. */
export async function runBackgroundUpdate(currentVersion: string, cachePath: string): Promise<void> {
  let tags: Record<string, string> | undefined;
  const capture = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.ok) tags = stringEntries(await response.clone().json().catch(() => null));
    return response;
  }) as typeof fetch;
  // The check's own 3 s abort can't end a DNS lookup; the pass goes on without its answer.
  await Promise.race([
    checkForUpdate({ currentVersion, cachePath, fetchFn: capture }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
  ]);
  const base = baseInstall();
  if (autoUpdateOffReason(process.env, readGlobalConfig()) !== null) return;
  // Only a verified npm or bun global install updates itself; the record lets the foreground drop the notice.
  const kind = await verifyInstallKind(base.packageDir, systemGlobalRoots());
  recordInstallKind(base.root, base.packageDir, base.version, kind);
  if (!kind) return;
  const log = (line: string) => appendUpdateLog(base.root, line);
  let outcome: AutoOutcome;
  try {
    outcome = await runAutoUpdate(defaultUpdater(base, log, tags));
  } catch (error) {
    log(`unexpected error, nothing changed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (outcome.action !== "none" && outcome.action !== "locked") log(JSON.stringify(outcome));
}

/** A verified version waiting only for Courier to stop, for the foreground notice. */
export function pendingSwitch(root: string, active: string): string | null {
  const pending = readState(root).pending;
  return pending && pending !== active && isVerified(root, pending) ? pending : null;
}

/** The last automatic switch, `{from, to, down}`, until a terminal run of `to` has said so. */
const LAST_SWITCH_FILE = "last-switch.json";
/** Written once the first-run notice has been shown for this versions root. */
const FIRST_RUN_FILE = "first-run-notice.json";

// User-facing copy: TC-4276, Monica (20:28Z), verbatim.
export const FIRST_RUN_NOTICE = [
  "TinyCloud CLI updates itself: it installs verified patch and minor releases of your channel in the background, once each has been on your channel for 6 hours. Major releases are never installed automatically. Log: ~/.tinycloud/versions/auto-update.log",
  "To turn this off, set \"autoUpdate\": false in ~/.tinycloud/config.json, or set TC_NO_AUTO_UPDATE=1.",
];

function switchedLine(from: string, to: string, down: boolean): string {
  return down
    ? `TinyCloud CLI moved back to ${to} (was ${from}) because your channel moved back.`
    : `TinyCloud CLI updated to ${to} (was ${from}).`;
}

/**
 * The automatic-update lines a terminal run of `running` shows, each once: the first-run notice (only where automatic
 * updates are on for a verified install; the caller checks), then the line for an automatic switch to `running`.
 * Marks them shown.
 */
export function takeAutoUpdateNotices(root: string, running: string, autoUpdating: boolean): string[] {
  const lines: string[] = [];
  if (autoUpdating && !existsSync(join(root, FIRST_RUN_FILE))) {
    writeFileAtomic(join(root, FIRST_RUN_FILE), `${JSON.stringify({ shown: running })}\n`);
    lines.push(...FIRST_RUN_NOTICE);
  }
  const last = readJson(join(root, LAST_SWITCH_FILE));
  if (last && typeof last === "object" && "to" in last && last.to === running && "from" in last && isVersion(last.from)) {
    rmSync(join(root, LAST_SWITCH_FILE), { force: true });
    lines.push(switchedLine(last.from, running, "down" in last && last.down === true));
  }
  return lines;
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

interface ProcessResult { code: number | null; stdout: string; stderr: string }

function runProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  // Executor form: the CLI supports Node 20, which lacks Promise.withResolvers.
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** Run npm (found by `resolveNpm`, never through a shell) in `cwd`; ENOENT when there's no npm. */
function runNpm(args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
  const npm = resolveNpm(env);
  if (!npm) return Promise.reject(Object.assign(new Error("npm not found"), { code: "ENOENT" }));
  return runProcess(npm.command, [...npm.args, ...args], { env, cwd, timeoutMs });
}

/** npm's and bun's global `node_modules` on this machine, for `verifyInstallKind`. */
export function systemGlobalRoots(env: NodeJS.ProcessEnv = process.env): GlobalRoots {
  return {
    async npm() {
      try {
        // From the home directory: a project .npmrc in the current directory must not move npm's global prefix.
        const result = await runNpm(["root", "-g"], homedir(), 30_000, env);
        return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
      } catch {
        return null;
      }
    },
    bun: () => bunGlobalModules(env),
  };
}

/** The production updater for the global install `install`, its versions root included. */
export function defaultUpdater(install: BaseInstall & { root: string }, log: (line: string) => void, fetchedTags?: Record<string, string>): UpdaterDeps {
  const { root, ...base } = install;
  return productionDeps(root, base, npmRegistry(), sigstoreVerifier(join(root, ".tuf")), log, fetchedTags);
}

function stringEntries(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The real registry, npm and node behind `UpdaterDeps`. `fetchedTags`: dist-tags this process already fetched. */
export function productionDeps(
  root: string,
  base: BaseInstall,
  registry: ReleaseRegistry,
  verifyBundle: BundleVerifier,
  log: (line: string) => void,
  fetchedTags?: Record<string, string>,
): UpdaterDeps {
  return {
    root,
    base,
    now: Date.now,
    registry: {
      manifest: (name, version) => registry.manifest(name, version),
      attestations: (name, version) => registry.attestations(name, version),
      keys: () => registry.keys(),
      publishedAt: (name, version) => registry.publishedAt(name, version),
      tarball: (name, version) => registry.tarball(name, version),
      async distTags() {
        if (fetchedTags) return fetchedTags;
        const response = await fetch(`${REGISTRY}/-/package/${packageUrlPath(CLI_PACKAGE)}/dist-tags`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`dist-tags returned ${response.status}`);
        const tags = stringEntries(await response.json());
        if (!tags) throw new Error("dist-tags unreadable");
        return tags;
      },
    },
    verifyBundle,
    async resolve(directory, version) {
      writeFileAtomic(join(directory, "package.json"), `${JSON.stringify({ private: true, dependencies: { [CLI_PACKAGE]: version } })}\n`);
      const result = await runNpm([
        "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", `${REGISTRY}/`,
      ], directory, 5 * 60 * 1000);
      if (result.code !== 0) throw new Error(`npm install --package-lock-only exited ${result.code}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
    },
    async install(directory) {
      const result = await runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", `${REGISTRY}/`], directory, 15 * 60 * 1000);
      if (result.code !== 0) throw new Error(`npm ci exited ${result.code}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
    },
    async run(bin, args) {
      const { code, stdout } = await runProcess(process.execPath, [bin, ...args], { env: { ...process.env, TC_NO_AUTO_UPDATE: "1" }, cwd: dirname(bin), timeoutMs: 120_000 });
      return { code, stdout };
    },
    log,
  };
}

