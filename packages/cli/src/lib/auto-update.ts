import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export function selectUpdateVersion(currentVersion: string, distTags: Record<string, string>): string | null {
  const current = parseVersion(currentVersion);
  if (!current) return null;
  const channel = current.prerelease[0];
  const candidateString = distTags[channel ?? "latest"];
  if (!candidateString) return null;

  const candidate = parseVersion(candidateString);
  if (!candidate) return null;
  if (channel === undefined ? candidate.prerelease.length > 0 : candidate.prerelease[0] !== channel) return null;
  return compareVersions(candidate, current) > 0 ? formatVersion(candidate) : null;
}

/**
 * The version the notice offers: a newer release on the install's own channel and, for a prerelease install, a
 * newer stable `latest` too, whichever is higher.
 */
export function selectNoticeVersion(currentVersion: string, distTags: Record<string, string>): string | null {
  const current = parseVersion(currentVersion);
  if (!current) return null;
  const own = selectUpdateVersion(currentVersion, distTags);
  const latest = current.prerelease.length > 0 && distTags.latest ? parseVersion(distTags.latest) : null;
  if (!latest || latest.prerelease.length > 0 || compareVersions(latest, current) <= 0) return own;
  if (own && compareVersions(parseVersion(own)!, latest) >= 0) return own;
  return formatVersion(latest);
}

type ParsedVersion = { major: number; minor: number; patch: number; prerelease: string[] };

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** `x.y.z[-pre]`: build metadata is dropped. */
function formatVersion(version: ParsedVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join(".")}`;
}

/** Semver order of two version strings; null when either is not a version. */
export function compareVersionStrings(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a && b ? compareVersions(a, b) : null;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3_000;
const STALE_LOCK_MS = 120_000;
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@tinycloud%2fcli/dist-tags";

type UpdateCache = { checkedAt: number; version: string | null };
type CheckOptions = {
  currentVersion: string;
  cachePath: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type InstallKind = "npm-global" | "bun-global" | "npx" | "homebrew" | "project" | "unknown";

function channelOf(currentVersion: string): string | null {
  const current = parseVersion(currentVersion);
  return current ? current.prerelease[0] ?? "latest" : null;
}

/** A cached offer is shown only while it is still newer than the running version, on a channel it may offer. */
function cachedOffer(currentVersion: string, version: string | null): string | null {
  return version ? selectNoticeVersion(currentVersion, { [channelOf(currentVersion)!]: version, latest: version }) : null;
}

/**
 * What a finished command may say, from the cache alone: the offered version, and whether the cache is missing or a
 * day old, so a new background check is due. Never touches the network.
 */
export function readUpdateCheck(currentVersion: string, cachePath: string, now = Date.now()): { due: boolean; version: string | null } {
  const channel = channelOf(currentVersion);
  if (!channel) return { due: false, version: null };
  let cached: UpdateCache | null = null;
  try {
    cached = parseFreshCache(readFileSync(`${cachePath}.${channel}`, "utf8"), now);
  } catch {
    // Missing or unreadable: a check is due.
  }
  if (!cached) return { due: true, version: null };
  return { due: false, version: cachedOffer(currentVersion, cached.version) };
}

/** Start the background check in a detached process that outlives the command and is never waited for. */
export function startUpdateCheck(entryPath: string, currentVersion: string, cachePath: string): void {
  const child = spawn(process.execPath, [entryPath, currentVersion, cachePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

/** The background check: one registry request per channel per day, shared by every process through the cache. */
export async function checkForUpdate({
  currentVersion,
  cachePath,
  now = Date.now,
  fetchFn = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
}: CheckOptions): Promise<string | null> {
  const channel = channelOf(currentVersion);
  if (!channel) return null;
  const time = now();
  const channelCachePath = `${cachePath}.${channel}`;
  const cached = await readFreshCache(channelCachePath, time);
  if (cached) return cachedOffer(currentVersion, cached.version);

  const releaseLock = await acquireLock(`${channelCachePath}.check-lock`);
  if (!releaseLock) {
    const concurrent = await readFreshCache(channelCachePath, time);
    return concurrent ? cachedOffer(currentVersion, concurrent.version) : null;
  }

  try {
    const afterLock = await readFreshCache(channelCachePath, time);
    if (afterLock) return cachedOffer(currentVersion, afterLock.version);
    // Recorded before the request: a registry that never answers counts as today's failed check.
    await writeCache(channelCachePath, { checkedAt: time, version: null });
    let version: string | null = null;
    try {
      const response = await fetchFn(DIST_TAGS_URL, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("registry request failed");
      const tags = await response.json() as unknown;
      if (tags && typeof tags === "object") {
        const distTags = Object.fromEntries(Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        version = selectNoticeVersion(currentVersion, distTags);
      }
    } catch {
      // A failed check stays recorded as failed until tomorrow.
    }
    if (version) await writeCache(channelCachePath, { checkedAt: time, version });
    return version;
  } finally {
    await releaseLock();
  }
}

export function isAutoUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.toLowerCase();
  const inCi = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
  return env.TC_NO_AUTO_UPDATE !== "1" && !inCi;
}

export function detectInstallKind(packagePath: string, workingDirectory: string, homeDirectory: string): InstallKind {
  const normalized = packagePath.replaceAll("\\", "/");
  if (normalized.includes("/Cellar/")) return "homebrew";
  if (normalized.includes("/_npx/") || normalized.includes("/_bunx/")) return "npx";
  if (isWithin(`${workingDirectory.replaceAll("\\", "/")}/node_modules`, normalized)) return "project";
  if (normalized.includes("/.bun/install/global/node_modules/")) return "bun-global";
  if (normalized.includes("/lib/node_modules/")) return "npm-global";
  if (normalized.startsWith(`${homeDirectory.replaceAll("\\", "/")}/.nvm/`)) return "npm-global";
  return "unknown";
}

const INSTALL_METHOD: Record<Exclude<InstallKind, "unknown">, string> = {
  "npm-global": "npm",
  "bun-global": "bun",
  npx: "npx",
  homebrew: "Homebrew",
  project: "this project's npm dependencies",
};

export function updateNotice(kind: InstallKind, currentVersion: string, availableVersion: string): string {
  const method = kind === "unknown" ? "" : `, installed with ${INSTALL_METHOD[kind]}`;
  return `TinyCloud CLI ${availableVersion} is available. This is ${currentVersion}${method}.`;
}

function parseFreshCache(text: string, now: number): UpdateCache | null {
  try {
    const cached = JSON.parse(text) as UpdateCache;
    if (Number.isFinite(cached.checkedAt) && cached.checkedAt <= now && now - cached.checkedAt < DAY_MS &&
        (cached.version === null || typeof cached.version === "string")) return cached;
  } catch {
    // A corrupt cache means a fresh check.
  }
  return null;
}

async function readFreshCache(cachePath: string, now: number): Promise<UpdateCache | null> {
  try {
    return parseFreshCache(await readFile(cachePath, "utf8"), now);
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, value: UpdateCache): Promise<void> {
  const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, cachePath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    // A cache failure only means the next process may check again.
  }
}

async function acquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await handle.close();
    return async () => { await rm(lockPath, { force: true }); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  }
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return recoverMalformedLock(lockPath);
  }
  if (!lock || typeof lock !== "object") return recoverMalformedLock(lockPath);
  const metadata = lock as { pid?: unknown; createdAt?: unknown };
  const now = Date.now();
  if (
    typeof metadata.pid !== "number" ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    typeof metadata.createdAt !== "number" ||
    !Number.isFinite(metadata.createdAt) ||
    metadata.createdAt > now
  ) return recoverMalformedLock(lockPath);
  // A lock holds only while it is younger than the stale window and names another process. Past the window its PID
  // may have been reused; this process's own PID means an earlier process with the same PID left it (PID 1 in a
  // container with a persistent HOME).
  if (metadata.pid !== process.pid && now - metadata.createdAt < STALE_LOCK_MS) return null;
  await rm(lockPath, { force: true });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await handle.close();
    return async () => { await rm(lockPath, { force: true }); };
  } catch {
    return null;
  }
}

async function recoverMalformedLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < STALE_LOCK_MS) return null;
    await rm(lockPath, { force: true });
    return acquireLock(lockPath);
  } catch {
    return null;
  }
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalizedParent);
}
