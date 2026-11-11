import { expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkForUpdate, detectInstallKind, isAutoUpdateEnabled, selectUpdateVersion, updateCommand } from "./auto-update.js";

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

test("checks once per day and reuses the cached update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-cache-"));
  const cachePath = join(directory, "cache.json");
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ version: "1.6.6" });
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
    return Response.json({ version: requests === 1 ? "1.6.6" : "1.6.7" });
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

test("recovers from an expired malformed update-check lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-lock-"));
  const cachePath = join(directory, "cache.json");
  const lockPath = `${cachePath}.beta.check-lock`;
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests += 1;
    return Response.json({ version: "1.7.0-beta.31" });
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

test("CI and explicit opt-out disable automatic checks", () => {
  expect(isAutoUpdateEnabled({})).toBe(true);
  expect(isAutoUpdateEnabled({ CI: "true" })).toBe(false);
  expect(isAutoUpdateEnabled({ TC_NO_AUTO_UPDATE: "1" })).toBe(false);
});

test("checks the stable or beta registry tag for the installed channel", async () => {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ version: urls.at(-1)?.endsWith("/beta") ? "1.7.0-beta.31" : "1.6.6" });
  };
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-channels-"));
  try {
    const stable = await checkForUpdate({ currentVersion: "1.6.5", cachePath: join(directory, "stable.json"), fetchFn });
    const beta = await checkForUpdate({ currentVersion: "1.7.0-beta.30", cachePath: join(directory, "beta.json"), fetchFn });
    expect(stable).toBe("1.6.6");
    expect(beta).toBe("1.7.0-beta.31");
    expect(urls).toEqual([
      "https://registry.npmjs.org/@tinycloud%2fcli/latest",
      "https://registry.npmjs.org/@tinycloud%2fcli/beta",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable and beta installs keep independent daily caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-channel-cache-"));
  const cachePath = join(directory, "shared.json");
  const requested: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    requested.push(String(input));
    return Response.json({ version: requested.at(-1)?.endsWith("/beta") ? "1.7.0-beta.31" : "1.6.6" });
  };
  try {
    await checkForUpdate({ currentVersion: "1.6.5", cachePath, fetchFn, now: () => 1_000_000 });
    await checkForUpdate({ currentVersion: "1.7.0-beta.30", cachePath, fetchFn, now: () => 1_001_000 });
    expect(requested).toEqual([
      "https://registry.npmjs.org/@tinycloud%2fcli/latest",
      "https://registry.npmjs.org/@tinycloud%2fcli/beta",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install type selects an exact manual update command", () => {
  expect(detectInstallKind("/opt/homebrew/Cellar/tinycloud-cli/1.6.5/lib/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("homebrew");
  expect(detectInstallKind("/home/agent/.bun/install/global/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("bun-global");
  expect(detectInstallKind("/home/agent/.npm/_npx/abc/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("npx");
  expect(detectInstallKind("/project/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("project");
  expect(detectInstallKind("/home/agent/.nvm/versions/node/v22/lib/node_modules/@tinycloud/cli", "/project", "/home/agent")).toBe("npm-global");
  expect(updateCommand("npm-global", "1.6.6")).toBe("npm install --global @tinycloud/cli@1.6.6");
  expect(updateCommand("bun-global", "1.7.0-beta.31")).toBe("bun install --global @tinycloud/cli@1.7.0-beta.31");
  expect(updateCommand("npx", "1.6.6")).toBe("npx --yes @tinycloud/cli@1.6.6");
  expect(updateCommand("project", "1.6.6")).toBe("npm install --save-dev @tinycloud/cli@1.6.6");
  expect(updateCommand("homebrew", "1.6.6")).toBe("brew upgrade tinycloud-cli");
});
