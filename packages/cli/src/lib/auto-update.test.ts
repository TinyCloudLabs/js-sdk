import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForUpdate,
  detectInstallKind,
  isAutoUpdateEnabled,
  readUpdateCheck,
  selectNoticeVersion,
  selectUpdateVersion,
  updateNotice,
} from "./auto-update.js";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@tinycloud%2fcli/dist-tags";

test("stable CLI selects only a newer stable latest release", () => {
  expect(selectUpdateVersion("1.6.5", {
    latest: "1.6.6",
    beta: "1.7.0-beta.31",
  })).toBe("1.6.6");
  expect(selectUpdateVersion("1.6.5", {
    latest: "1.7.0-beta.31",
    beta: "1.7.0-beta.31",
  })).toBeNull();
});

test("beta CLI follows only its own prerelease channel", () => {
  expect(selectUpdateVersion("1.7.0-beta.30", {
    latest: "1.6.5",
    beta: "1.7.0-beta.31",
  })).toBe("1.7.0-beta.31");
  expect(selectUpdateVersion("1.7.0-beta.30", {
    latest: "1.6.6",
  })).toBeNull();
  expect(selectUpdateVersion("1.7.0-beta.30", {
    latest: "1.6.6",
    beta: "1.7.0",
  })).toBeNull();
});

test("rejects invalid and non-newer version tags", () => {
  expect(selectUpdateVersion("not-a-version", { latest: "2.0.0" })).toBeNull();
  expect(selectUpdateVersion("1.6.5", { latest: "1.6.5" })).toBeNull();
  expect(selectUpdateVersion("1.6.5", { latest: "1.6.4" })).toBeNull();
});

test("registry versions are offered as x.y.z[-pre], without build metadata", () => {
  expect(selectUpdateVersion("1.6.5", { latest: "1.6.6+build.7" })).toBe("1.6.6");
  expect(selectUpdateVersion("1.7.0-beta.30", { beta: "1.7.0-beta.31+sha.abc" })).toBe("1.7.0-beta.31");
  expect(selectNoticeVersion("1.7.0-beta.30", { latest: "1.7.0+build.1" })).toBe("1.7.0");
});

test("the notice also offers a beta install a higher stable release, and never a stable install a beta", () => {
  expect(selectNoticeVersion("1.9.0-beta.21", { beta: "1.9.0-beta.21", latest: "1.9.2" })).toBe("1.9.2");
  expect(selectNoticeVersion("1.9.0-beta.21", { beta: "1.10.0-beta.1", latest: "1.9.2" })).toBe("1.10.0-beta.1");
  expect(selectNoticeVersion("1.9.0-beta.21", { beta: "1.9.0-beta.22", latest: "1.9.0" })).toBe("1.9.0");
  expect(selectNoticeVersion("1.9.0-beta.21", { beta: "1.9.0-beta.22", latest: "1.8.9" })).toBe("1.9.0-beta.22");
  expect(selectNoticeVersion("1.9.0-beta.21", { latest: "1.10.0-beta.1" })).toBeNull();
  expect(selectNoticeVersion("1.9.2", { beta: "1.10.0-beta.1", latest: "1.9.2" })).toBeNull();
});

test("checks once per day and reuses the cached update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-cache-"));
  const cachePath = join(directory, "cache.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ latest: "1.6.6" });
  };
  try {
    const first = await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 });
    const second = await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_001_000 });
    expect(first).toBe("1.6.6");
    expect(second).toBe("1.6.6");
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes the version check after the daily cache expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-expiry-"));
  const cachePath = join(directory, "cache.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ latest: requests === 1 ? "1.6.6" : "1.6.7" });
  };
  try {
    expect(await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 })).toBe("1.6.6");
    expect(await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 + 86_400_001 })).toBe("1.6.7");
    expect(requests).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline update checks fail open and cache the attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-offline-"));
  const cachePath = join(directory, "cache.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    throw new Error("offline");
  };
  try {
    expect(await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 })).toBeNull();
    expect(await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_001_000 })).toBeNull();
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a registry that never answers is already recorded as today's failed check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-hang-"));
  const cachePath = join(directory, "cache.json");
  const requested = Promise.withResolvers<void>();
  const fetchFn: typeof fetch = () => {
    requested.resolve();
    return new Promise<Response>(() => {});
  };
  try {
    void checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn });
    await requested.promise;
    expect(JSON.parse(await readFile(`${cachePath}.latest`, "utf8"))).toMatchObject({ version: null });
    expect(readUpdateCheck("1.6.5", cachePath)).toEqual({ due: false, version: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a finished command reads only the cache: due when missing or a day old, an offer only while it is newer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-read-"));
  const cachePath = join(directory, "cache.json");
  const now = 10 * 86_400_000;
  try {
    expect(readUpdateCheck("1.9.0-beta.21", cachePath, now)).toEqual({ due: true, version: null });
    await writeFile(`${cachePath}.beta`, JSON.stringify({ checkedAt: now - 1_000, version: "1.9.2" }));
    expect(readUpdateCheck("1.9.0-beta.21", cachePath, now)).toEqual({ due: false, version: "1.9.2" });
    expect(readUpdateCheck("1.9.3-beta.0", cachePath, now)).toEqual({ due: false, version: null });
    await writeFile(`${cachePath}.beta`, JSON.stringify({ checkedAt: now - 86_400_001, version: "1.9.2" }));
    expect(readUpdateCheck("1.9.0-beta.21", cachePath, now)).toEqual({ due: true, version: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers from an expired malformed update-check lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-lock-"));
  const cachePath = join(directory, "cache.json");
  const lockPath = `${cachePath}.beta.check-lock`;
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ beta: "1.7.0-beta.31" });
  };
  try {
    await writeFile(lockPath, "{", { mode: 0o600 });
    const stale = new Date(Date.now() - 121_000);
    await utimes(lockPath, stale, stale);
    expect(await checkForUpdate({
      currentVersion: "1.7.0-beta.30",
      cachePath,
      fetchFn,
    })).toBe("1.7.0-beta.31");
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test.each([
  ["null lock data", "null"],
  ["zero pid", JSON.stringify({ pid: 0, createdAt: Date.now() - 121_000 })],
  ["negative pid", JSON.stringify({ pid: -1, createdAt: Date.now() - 121_000 })],
  ["future timestamp", JSON.stringify({ pid: process.pid, createdAt: Date.now() + 60_000 })],
])("recovers invalid update-check lock metadata (%s)", async (_label, contents) => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-lock-metadata-"));
  const cachePath = join(directory, "cache.json");
  const lockPath = `${cachePath}.beta.check-lock`;
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ beta: "1.7.0-beta.31" });
  };
  try {
    await writeFile(lockPath, contents, { mode: 0o600 });
    const stale = new Date(Date.now() - 121_000);
    await utimes(lockPath, stale, stale);
    expect(await checkForUpdate({
      currentVersion: "1.7.0-beta.30",
      cachePath,
      fetchFn,
    })).toBe("1.7.0-beta.31");
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["another live process holds a fresh lock", process.ppid, 1_000, 0],
  ["a live PID's lock is past the stale window", process.ppid, 121_000, 1],
  ["a fresh lock names this process's own PID, left by an earlier process", process.pid, 1_000, 1],
])("update-check lock: %s", async (_label, pid, ageMs, expectedRequests) => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-lock-owner-"));
  const cachePath = join(directory, "cache.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ beta: "1.7.0-beta.31" });
  };
  try {
    await writeFile(`${cachePath}.beta.check-lock`, JSON.stringify({ pid, createdAt: Date.now() - ageMs }), { mode: 0o600 });
    const result = await checkForUpdate({ currentVersion: "1.7.0-beta.30", cachePath, fetchFn });
    expect(requests).toBe(expectedRequests);
    expect(result).toBe(expectedRequests === 1 ? "1.7.0-beta.31" : null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CI and explicit opt-out disable automatic checks", () => {
  expect(isAutoUpdateEnabled({})).toBe(true);
  expect(isAutoUpdateEnabled({ CI: "true" })).toBe(false);
  expect(isAutoUpdateEnabled({ TC_NO_AUTO_UPDATE: "1" })).toBe(false);
});

test("any CI value other than false or 0 disables automatic checks", () => {
  for (const CI of ["1", "TRUE", "yes", "github-actions"]) expect({ CI, enabled: isAutoUpdateEnabled({ CI }) }).toEqual({ CI, enabled: false });
  for (const CI of ["", "false", "FALSE", "0"]) expect({ CI, enabled: isAutoUpdateEnabled({ CI }) }).toEqual({ CI, enabled: true });
});

test("stable and beta installs read their own tag from one dist-tags request", async () => {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ latest: "1.6.6", beta: "1.7.0-beta.31" });
  };
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-channels-"));
  try {
    const stable = await checkForUpdate({ currentVersion: "1.6.5", cachePath: join(directory, "stable.json"), fetchFn });
    const beta = await checkForUpdate({ currentVersion: "1.7.0-beta.30", cachePath: join(directory, "beta.json"), fetchFn });
    expect(stable).toBe("1.6.6");
    expect(beta).toBe("1.7.0-beta.31");
    expect(urls).toEqual([DIST_TAGS_URL, DIST_TAGS_URL]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable and beta installs keep independent daily caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-channel-cache-"));
  const cachePath = join(directory, "shared.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ latest: "1.6.6", beta: "1.7.0-beta.31" });
  };
  try {
    expect(await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 })).toBe("1.6.6");
    expect(await checkForUpdate({ currentVersion: "1.7.0-beta.30", cachePath, fetchFn, now: () => 1_001_000 })).toBe("1.7.0-beta.31");
    expect(requests).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install type selects the install method named in the notice, with no command", () => {
  expect(detectInstallKind("/opt/homebrew/Cellar/tinycloud-cli/1.6.5/lib/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("homebrew");
  expect(detectInstallKind("/home/agent/.bun/install/global/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("bun-global");
  expect(detectInstallKind("/home/agent/.npm/_npx/abc/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("npx");
  expect(detectInstallKind("/project/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("project");
  expect(detectInstallKind("/home/agent/.nvm/versions/node/v22/lib/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("npm-global");
  const kinds = ["npm-global", "bun-global", "npx", "homebrew", "project", "unknown"] as const;
  expect(updateNotice("npm-global", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5, installed with npm.");
  expect(updateNotice("bun-global", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5, installed with bun.");
  expect(updateNotice("npx", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5, installed with npx.");
  expect(updateNotice("homebrew", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5, installed with Homebrew.");
  expect(updateNotice("project", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5, installed with this project's npm dependencies.");
  expect(updateNotice("unknown", "1.6.5", "1.6.6")).toBe("TinyCloud CLI 1.6.6 is available. This is 1.6.5.");
  for (const kind of kinds) {
    expect(updateNotice(kind, "1.6.5", "1.6.6")).not.toMatch(/\brun\b|install --|npx --yes|brew upgrade|bun install|npm install/i);
  }
});
