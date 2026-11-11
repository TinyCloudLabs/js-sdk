import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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
  return compareVersions(candidate, current) > 0 ? candidateString : null;
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

type UpdateCache = { checkedAt: number; version: string | null };
type CheckOptions = {
  currentVersion: string;
  cachePath: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type InstallKind = "npm-global" | "bun-global" | "npx" | "homebrew" | "project" | "unknown";

export async function checkForUpdate({
  currentVersion,
  cachePath,
  now = Date.now,
  fetchFn = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
}: CheckOptions): Promise<string | null> {
  if (!parseVersion(currentVersion)) return null;
  const channel = parseVersion(currentVersion)!.prerelease[0] ?? "latest";
  const time = now();
  const channelCachePath = `${cachePath}.${channel}`;
  const cached = await readFreshCache(channelCachePath, time);
  if (cached) return cached.version && selectUpdateVersion(currentVersion, { [channel]: cached.version }) ? cached.version : null;

  const releaseLock = await acquireLock(`${channelCachePath}.check-lock`);
  if (!releaseLock) {
    const concurrent = await readFreshCache(channelCachePath, time);
    return concurrent?.version && selectUpdateVersion(currentVersion, { [channel]: concurrent.version }) ? concurrent.version : null;
  }

  let version: string | null = null;
  try {
    const afterLock = await readFreshCache(channelCachePath, time);
    if (afterLock) return afterLock.version && selectUpdateVersion(currentVersion, { [channel]: afterLock.version }) ? afterLock.version : null;
    try {
      const response = await fetchFn(`https://registry.npmjs.org/@tinycloud%2fcli/${channel}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("registry request failed");
      const metadata = await response.json() as { version?: unknown };
      if (typeof metadata.version === "string") version = selectUpdateVersion(currentVersion, { [channel]: metadata.version });
    } catch {
      // Update checks must not affect the command.
    }
    await writeCache(channelCachePath, { checkedAt: time, version });
    return version;
  } finally {
    await releaseLock();
  }
}

export function isAutoUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TC_NO_AUTO_UPDATE !== "1" && env.CI?.toLowerCase() !== "true";
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

export function updateCommand(kind: InstallKind, version: string, packagePath?: string): string {
  switch (kind) {
    case "npm-global": return `npm install --global @tinycloud/cli@${version}`;
    case "bun-global": return `bun install --global @tinycloud/cli@${version}`;
    case "npx": return `npx --yes @tinycloud/cli@${version}`;
    case "homebrew": {
      const formula = /\/Cellar\/([A-Za-z0-9@+._-]+)\//.exec(packagePath?.replaceAll("\\", "/") ?? "")?.[1] ?? "tinycloud-cli";
      return `brew upgrade ${formula}`;
    }
    case "project": return `npm install --save-dev @tinycloud/cli@${version}`;
    case "unknown": return `npm install --global @tinycloud/cli@${version}`;
  }
}

export function updateNotice(kind: InstallKind, currentVersion: string, availableVersion: string, packagePath?: string): string {
  return `TinyCloud CLI ${availableVersion} is available (you have ${currentVersion}). To update, run: ${updateCommand(kind, availableVersion, packagePath)}`;
}

let finishNotice: (() => Promise<void>) | undefined;
let noticeFinished = false;

export function registerUpdateNoticeFinalizer(finalizer: () => Promise<void>): void {
  finishNotice = finalizer;
}

export async function finishUpdateNotice(): Promise<void> {
  if (noticeFinished) return;
  noticeFinished = true;
  await finishNotice?.().catch(() => undefined);
}

async function readFreshCache(cachePath: string, now: number): Promise<UpdateCache | null> {
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as UpdateCache;
    if (Number.isFinite(cached.checkedAt) && cached.checkedAt <= now && now - cached.checkedAt < DAY_MS &&
        (cached.version === null || typeof cached.version === "string")) return cached;
  } catch {
    // Missing or corrupt cache means a fresh check.
  }
  return null;
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
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; createdAt?: number };
    if (!Number.isSafeInteger(lock.pid) || typeof lock.createdAt !== "number" || Date.now() - lock.createdAt < 120_000) return null;
    try {
      process.kill(lock.pid as number, 0);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
    }
    await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await handle.close();
    return async () => { await rm(lockPath, { force: true }); };
  } catch {
    return null;
  }
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalizedParent);
}
