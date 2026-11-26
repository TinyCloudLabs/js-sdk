import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeRegistry, OTHER_IDENTITY, fakeUpdater, fakeVerifier, lockfileFor, type FakeUpdater } from "../test-support/self-update-fakes.js";
import {
  autoUpdateCovers,
  autoUpdateOffReason,
  firstRunNotice,
  pendingSwitch,
  productionDeps,
  runAutoUpdate,
  runManualUpgrade,
  SOAK_MS,
  takeAutoUpdateNotices,
} from "./self-update.js";
import { isVerified, readPointer, versionPackageDir } from "./versions.js";

const HOUR = 60 * 60 * 1000;

function registryWith(...cliVersions: string[]): FakeRegistry {
  const registry = new FakeRegistry().publish("chalk", "5.3.0");
  for (const version of cliVersions) registry.publish("@tinycloud/cli", version);
  return registry;
}

/** Tag `version` as latest and run the updater once the soak has passed. */
async function releaseAndSoak(fake: FakeUpdater, version: string) {
  fake.registry.tags.latest = version;
  const first = await runAutoUpdate(fake.deps);
  expect(first).toMatchObject({ action: "soaking", version });
  fake.clock.now += SOAK_MS;
  return runAutoUpdate(fake.deps);
}

describe("version gate", () => {
  test("patch and minor releases on the channel install automatically; a major only reports", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.10.0", "2.0.0"));
    expect(await releaseAndSoak(fake, "1.9.5")).toMatchObject({ action: "switched", version: "1.9.5", from: "1.9.4" });
    expect(fake.active()).toBe("1.9.5");
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.9.5", base: "1.9.4", auto: true, pinned: false });

    expect(await releaseAndSoak(fake, "1.10.0")).toMatchObject({ action: "switched", version: "1.10.0" });

    fake.registry.tags.latest = "2.0.0";
    fake.clock.now += SOAK_MS * 10;
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "major-available", version: "2.0.0" });
    expect(fake.staged).toEqual(["1.9.5", "1.10.0"]);
    expect(fake.active()).toBe("1.10.0");
  });

  test("a stable install ignores prerelease tags, and a beta install follows only its channel", async () => {
    const stable = fakeUpdater("1.9.4", registryWith("1.10.0-beta.1"));
    stable.registry.tags = { latest: "1.9.4", beta: "1.10.0-beta.1" };
    expect(await runAutoUpdate(stable.deps)).toEqual({ action: "none" });

    const beta = fakeUpdater("1.10.0-beta.1", registryWith("1.10.0-beta.2"));
    beta.registry.tags = { latest: "1.9.4", beta: "1.10.0-beta.2" };
    expect(await runAutoUpdate(beta.deps)).toMatchObject({ action: "soaking", version: "1.10.0-beta.2" });
    beta.clock.now += SOAK_MS;
    expect(await runAutoUpdate(beta.deps)).toMatchObject({ action: "switched", version: "1.10.0-beta.2" });
  });
});

describe("soak", () => {
  test("a release installs only 6 h after this machine first saw it as the tag; a newer tag restarts the wait", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    const start = fake.clock.now;
    fake.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "soaking", version: "1.9.5", dueAt: start + SOAK_MS });
    fake.clock.now = start + 5 * HOUR;
    fake.registry.tags.latest = "1.9.6";
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "soaking", version: "1.9.6", dueAt: start + 5 * HOUR + SOAK_MS });
    fake.clock.now = start + 6 * HOUR;
    expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "soaking", version: "1.9.6" });
    expect(fake.staged).toEqual([]);
    fake.clock.now = start + 11 * HOUR;
    expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "switched", version: "1.9.6" });
  });

  test("a manual upgrade doesn't wait for the soak", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toEqual({ status: "ok", from: "1.9.4", to: "1.9.5", changed: true });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.9.5", auto: false, pinned: false });
  });
});

describe("notice suppression", () => {
  const on = { installKind: "npm-global" as const, offReason: null, npmOnPath: true, pinned: false };
  test("only a same-channel, same-major release on a verified install with auto-update on skips the notice", () => {
    expect(autoUpdateCovers({ ...on, current: "1.9.4", available: "1.10.0" })).toBe(true);
    expect(autoUpdateCovers({ ...on, current: "1.9.4", available: "2.0.0" })).toBe(false);
    // #1054 offers a beta install the higher `latest`; the updater stays on beta, so the notice stays.
    expect(autoUpdateCovers({ ...on, current: "1.10.0-beta.2", available: "1.10.0" })).toBe(false);
    expect(autoUpdateCovers({ ...on, current: "1.10.0-beta.2", available: "1.10.0-beta.3" })).toBe(true);
    expect(autoUpdateCovers({ ...on, installKind: "unknown", current: "1.9.4", available: "1.10.0" })).toBe(false);
    expect(autoUpdateCovers({ ...on, pinned: true, current: "1.9.4", available: "1.10.0" })).toBe(false);
    expect(autoUpdateCovers({ ...on, npmOnPath: false, current: "1.9.4", available: "1.10.0" })).toBe(false);
    expect(autoUpdateCovers({ ...on, offReason: "config", current: "1.9.4", available: "1.10.0" })).toBe(false);
  });
});

describe("off switches", () => {
  const home = homedir();
  test("TC_NO_AUTO_UPDATE, CI and the config setting each turn automatic updates off", () => {
    expect(autoUpdateOffReason({ TC_NO_AUTO_UPDATE: "1" }, undefined, home)).toBe("env");
    for (const CI of ["1", "true", "TRUE", "yes", "github"]) expect(autoUpdateOffReason({ CI }, undefined, home)).toBe("ci");
    for (const CI of ["", "false", "False", "0"]) expect(autoUpdateOffReason({ CI }, undefined, home)).toBeNull();
    expect(autoUpdateOffReason({}, { defaultProfile: "default", version: 1, autoUpdate: false }, home)).toBe("config");
    expect(autoUpdateOffReason({}, { defaultProfile: "default", version: 1 }, home)).toBeNull();
    expect(autoUpdateOffReason({}, undefined, home)).toBeNull();
  });

  test("a sandboxed TC_HOME turns them off unless TC_VERSIONS_DIR is set too", () => {
    expect(autoUpdateOffReason({ TC_HOME: "/tmp/qa-home" }, undefined, home)).toBe("sandbox");
    expect(autoUpdateOffReason({ TC_HOME: "/tmp/qa-home", TC_VERSIONS_DIR: "/tmp/qa-versions" }, undefined, home)).toBeNull();
    expect(autoUpdateOffReason({ TC_HOME: home }, undefined, home)).toBeNull();
  });
});

describe("lock", () => {
  test("two updaters at once lead to one install", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    await runAutoUpdate(fake.deps);
    fake.clock.now += SOAK_MS;
    let release!: () => void;
    fake.holdStage = new Promise<void>((resolve) => { release = resolve; });
    const staging = new Promise<void>((resolve) => { fake.onStage = resolve; });
    const first = runAutoUpdate(fake.deps);
    await staging;
    const second = await runAutoUpdate(fake.deps);
    release();
    expect(second).toEqual({ action: "locked" });
    expect(await first).toMatchObject({ action: "switched", version: "1.9.5" });
    expect(fake.staged).toEqual(["1.9.5"]);
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "ok", changed: false });
  });
});

describe("failures leave the previous version running", () => {
  test("a staged version that fails its smoke test is never switched to, and nothing of it is kept", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.smokeFails.add("1.9.5");
    expect(await releaseAndSoak(fake, "1.9.5")).toMatchObject({
      action: "failed",
      result: { status: "failed-rolled-back", reason: "SMOKE_FAILED", current: "1.9.4" },
    });
    expect(readPointer(fake.deps.root)).toBeNull();
    expect(existsSync(join(fake.deps.root, "1.9.5"))).toBe(false);
    expect(fake.active()).toBe("1.9.4");
  });

  test("a switch the launcher doesn't confirm is rolled back to the previous pointer", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    await releaseAndSoak(fake, "1.9.5");
    const before = readPointer(fake.deps.root);
    fake.launcherFailures.count = 1;
    expect(await releaseAndSoak(fake, "1.9.6")).toMatchObject({
      action: "failed",
      result: { status: "failed-rolled-back", reason: "SWITCH_FAILED", from: "1.9.5", to: "1.9.6", current: "1.9.5" },
    });
    expect(readPointer(fake.deps.root)).toEqual(before);
    expect(fake.active()).toBe("1.9.5");
  });

  test("a switch that can't be confirmed or undone reports failed-not-rolled-back", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    fake.launcherFailures.count = 2;
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "failed-not-rolled-back", reason: "SWITCH_FAILED" });
  });

  test("a release whose provenance fails is not installed or switched to", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.publish("@tinycloud/cli", "1.9.6", { identity: OTHER_IDENTITY }).publish("@tinycloud/cli", "1.9.7", { attested: false });
    await releaseAndSoak(fake, "1.9.5");
    expect(await releaseAndSoak(fake, "1.9.6")).toMatchObject({ action: "failed", result: { status: "refused", reason: "PROVENANCE_INVALID" } });
    expect(await releaseAndSoak(fake, "1.9.7")).toMatchObject({ action: "failed", result: { status: "refused", reason: "PROVENANCE_MISSING" } });
    expect(fake.staged).toEqual(["1.9.5"]);
    expect(fake.active()).toBe("1.9.5");
  });

  test("a dependency with the wrong provenance identity refuses the whole release", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.publish("@tinycloud/sdk-core", "3.14.0", { identity: OTHER_IDENTITY });
    fake.registry.tree.push({ name: "@tinycloud/sdk-core", version: "3.14.0" });
    expect(await releaseAndSoak(fake, "1.9.5")).toMatchObject({ action: "failed", result: { status: "refused", reason: "PROVENANCE_INVALID" } });
    expect(fake.active()).toBe("1.9.4");
    expect(isVerified(fake.deps.root, "1.9.5")).toBe(false);
  });
});

describe("Courier", () => {
  test("no switch while Courier runs from the active version; the switch happens once it has stopped", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.alive.add(4242);
    fake.lease(4242, "1.9.4", true);
    expect(await releaseAndSoak(fake, "1.9.5")).toEqual({ action: "deferred", version: "1.9.5" });
    expect(fake.active()).toBe("1.9.4");
    expect(isVerified(fake.deps.root, "1.9.5")).toBe(true);
    expect(pendingSwitch(fake.deps.root, "1.9.4")).toBe("1.9.5");
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "refused", reason: "COURIER_RUNNING", to: "1.9.5" });

    fake.alive.delete(4242);
    fake.clock.now += HOUR;
    expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "switched", version: "1.9.5" });
    expect(fake.staged).toEqual(["1.9.5"]);
    expect(pendingSwitch(fake.deps.root, "1.9.5")).toBeNull();
  });

  test("Courier running from another version doesn't hold the switch", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.alive.add(4242);
    fake.lease(4242, "1.9.3", true);
    expect(await releaseAndSoak(fake, "1.9.5")).toMatchObject({ action: "switched", version: "1.9.5" });
  });
});

describe("running processes", () => {
  test("a version a live process uses keeps its files untouched through later switches, and is pruned after it exits", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6", "1.9.7", "1.9.8"));
    await releaseAndSoak(fake, "1.9.5");
    const file = join(versionPackageDir(fake.deps.root, "1.9.5"), "package.json");
    const before = statSync(file);
    fake.alive.add(5151);
    fake.lease(5151, "1.9.5", false);
    await releaseAndSoak(fake, "1.9.6");
    await releaseAndSoak(fake, "1.9.7");
    expect(fake.active()).toBe("1.9.7");
    const after = statSync(file);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

    fake.alive.delete(5151);
    await releaseAndSoak(fake, "1.9.8");
    expect(existsSync(join(fake.deps.root, "1.9.5"))).toBe(false);
    expect(existsSync(join(fake.deps.root, "1.9.7"))).toBe(true);
    expect(existsSync(join(fake.deps.root, "1.9.8"))).toBe(true);
  });
});

/** Move the latest tag back to `version` and run the updater once the soak has passed. */
async function rollBackAndSoak(fake: FakeUpdater, version: string) {
  fake.registry.tags.latest = version;
  expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "soaking", version });
  fake.clock.now += SOAK_MS - 1;
  expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "soaking", version });
  fake.clock.now += 1;
  return runAutoUpdate(fake.deps);
}

describe("following the tag down", () => {
  test("an automatically installed version follows a lower tag in the same major once it has soaked, down to the installed version", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    await releaseAndSoak(fake, "1.9.5");
    await releaseAndSoak(fake, "1.9.6");
    expect(await rollBackAndSoak(fake, "1.9.5")).toEqual({ action: "followed-down", version: "1.9.5", from: "1.9.6" });
    expect(fake.active()).toBe("1.9.5");

    expect(await rollBackAndSoak(fake, "1.9.4")).toEqual({ action: "followed-down", version: "1.9.4", from: "1.9.5" });
    expect(fake.active()).toBe("1.9.4");
  });

  test("a tag below the version installed by hand is never followed", async () => {
    const fake = fakeUpdater("1.9.5", registryWith("1.9.4", "1.9.6"));
    await releaseAndSoak(fake, "1.9.6");
    fake.registry.tags.latest = "1.9.4";
    fake.clock.now += SOAK_MS * 10;
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "none" });
    fake.clock.now += SOAK_MS * 10;
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "none" });
    expect(fake.active()).toBe("1.9.6");
    expect(fake.staged).toEqual(["1.9.6"]);
  });

  test("a rolled-back tag that fails verification is not followed", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.6"));
    fake.registry.publish("@tinycloud/cli", "1.9.5", { attested: false });
    await releaseAndSoak(fake, "1.9.6");
    expect(await rollBackAndSoak(fake, "1.9.5")).toMatchObject({ action: "failed", result: { reason: "PROVENANCE_MISSING" } });
    expect(fake.active()).toBe("1.9.6");
  });

  test("manual and pinned installs don't follow the tag down, and no tag crosses a major", async () => {
    const manual = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    manual.registry.tags.latest = "1.9.6";
    await runManualUpgrade(manual.deps, { installKind: "npm-global" });
    manual.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(manual.deps)).toEqual({ action: "none" });
    expect(manual.active()).toBe("1.9.6");

    const pinned = fakeUpdater("1.10.0", registryWith("1.10.2"));
    await runManualUpgrade(pinned.deps, { installKind: "npm-global", to: "1.10.2" });
    pinned.registry.tags.latest = "1.10.1";
    expect(await runAutoUpdate(pinned.deps)).toEqual({ action: "pinned", version: "1.10.2" });

    const major = fakeUpdater("2.0.0", registryWith("2.0.1"));
    await releaseAndSoak(major, "2.0.1");
    major.registry.tags.latest = "1.9.9";
    expect(await runAutoUpdate(major.deps)).toEqual({ action: "none" });
    expect(major.active()).toBe("2.0.1");
  });

  test("a follow-down never goes below the last tinycloud upgrade target, even after an automatic update above it", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1", "1.10.3", "1.10.4"));
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global", to: "1.10.3" })).toMatchObject({ status: "ok", to: "1.10.3" });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.10.3", pinned: true, floor: "1.10.3" });
    // A plain upgrade ends the pin; then the updater moves up on its own.
    fake.registry.tags.latest = "1.10.3";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "ok", changed: false });
    expect(await releaseAndSoak(fake, "1.10.4")).toMatchObject({ action: "switched", version: "1.10.4" });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.10.4", auto: true, floor: "1.10.3" });

    // The channel moves back to 1.10.1: above the global install (1.10.0), below the upgrade target.
    fake.registry.tags.latest = "1.10.1";
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "none" });
    fake.clock.now += SOAK_MS * 10;
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "none" });
    expect(fake.active()).toBe("1.10.4");
    expect(fake.staged).toEqual(["1.10.3", "1.10.4"]);

    // Down to the target itself is allowed.
    expect(await rollBackAndSoak(fake, "1.10.3")).toEqual({ action: "followed-down", version: "1.10.3", from: "1.10.4" });
  });
});

describe("manual upgrade", () => {
  test("installs that tinycloud upgrade can't manage are refused", async () => {
    for (const installKind of ["npx", "project", "homebrew", "unknown"] as const) {
      const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
      fake.registry.tags.latest = "1.9.5";
      expect(await runManualUpgrade(fake.deps, { installKind })).toEqual({ status: "refused", reason: "UNSUPPORTED_INSTALL", from: "1.9.4" });
      expect(fake.staged).toEqual([]);
    }
  });

  test("--to pins an exact version (down too), a plain upgrade unpins, and --to below 1.10.0 refuses", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1", "1.10.2", "1.9.9"));
    fake.registry.tags.latest = "1.10.2";
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global" })).toMatchObject({ status: "ok", to: "1.10.2" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.10.1" })).toMatchObject({ status: "ok", from: "1.10.2", to: "1.10.1", changed: true });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.10.1", pinned: true });
    fake.registry.tags.latest = "1.10.1";
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global" })).toMatchObject({ status: "ok", changed: false });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.10.1", pinned: false });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.9.9" })).toMatchObject({ status: "refused", reason: "TARGET_TOO_OLD" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "latest" })).toMatchObject({ status: "refused", reason: "INVALID_VERSION" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.10.9" })).toMatchObject({ status: "refused", reason: "VERSION_NOT_FOUND" });
  });

  test("without --to a lower tag is never a downgrade", async () => {
    const fake = fakeUpdater("1.9.6", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toEqual({ status: "ok", from: "1.9.6", to: "1.9.6", changed: false });
    expect(fake.staged).toEqual([]);
  });

  test("answering no changes nothing", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global", confirm: async () => false })).toMatchObject({ status: "refused", reason: "DECLINED" });
    expect(fake.staged).toEqual([]);
    expect(readPointer(fake.deps.root)).toBeNull();
  });

  test("under Bun older than 1.4 nothing is fetched or staged: UNSUPPORTED_RUNTIME, in the background too", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1"));
    fake.registry.tags.latest = "1.10.1";
    fake.deps.bunVersion = "1.3.14";
    const refusal = { status: "refused", reason: "UNSUPPORTED_RUNTIME", from: "1.10.0", detail: "Bun 1.3.14" } as const;
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.10.1" })).toEqual(refusal);
    fake.clock.now += SOAK_MS * 10;
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "refused", result: refusal });
    expect(fake.staged).toEqual([]);
    expect(readPointer(fake.deps.root)).toBeNull();
    expect(readdirSync(fake.deps.root).filter((name) => /^\d/.test(name) || name.startsWith(".staging-"))).toEqual([]);

    fake.deps.bunVersion = "1.4.0";
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.10.1" })).toMatchObject({ status: "ok", to: "1.10.1" });
  });
});

describe("dependencies are checked before npm installs or runs anything", () => {
  test("a release pinning a git dependency whose prepare script writes a marker is refused, and the marker never exists", async () => {
    // The real npm behind `productionDeps`, against a local git repository: had the shrinkwrap reached npm, npm would
    // have cloned the dependency and run its `prepare` script even with --ignore-scripts.
    const fake = fakeUpdater("1.10.0");
    const repo = join(fake.dir, "evil-dep");
    const marker = join(fake.dir, "prepare-ran");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "evil-dep",
      version: "1.0.0",
      scripts: { prepare: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` },
    }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "evil");
    const resolved = `git+file://${repo}#${git("rev-parse", "HEAD")}`;
    fake.registry.publish("@tinycloud/cli", "1.10.1", { shrinkwrap: lockfileFor([{ name: "evil-dep", version: "1.0.0", resolved }]) });
    fake.registry.tags.latest = "1.10.1";
    const deps = productionDeps(fake.deps.root, fake.deps.base, fake.registry, fakeVerifier, (line) => fake.logs.push(line), { latest: "1.10.1" });

    expect(await runManualUpgrade(deps, { installKind: "npm-global" })).toMatchObject({ status: "refused", reason: "DEPENDENCY_NOT_FROM_REGISTRY", to: "1.10.1" });
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(fake.deps.root).filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
    expect(readPointer(fake.deps.root)).toBeNull();
  });

  test("a release without npm-shrinkwrap.json is refused as too old", async () => {
    const fake = fakeUpdater("1.10.0");
    fake.registry.publish("@tinycloud/cli", "1.10.1", { shrinkwrap: false });
    fake.registry.tags.latest = "1.10.1";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "refused", reason: "TARGET_TOO_OLD" });
    expect(fake.staged).toEqual([]);
  });

  test("an install that doesn't match the verified lockfile is discarded", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1"));
    fake.afterInstall = (directory) => writeFileSync(join(directory, "node_modules", "chalk", "package.json"), JSON.stringify({ name: "chalk", version: "6.6.6" }));
    fake.registry.tags.latest = "1.10.1";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "failed-rolled-back", reason: "INSTALL_FAILED", current: "1.10.0" });
    expect(fake.active()).toBe("1.10.0");
    expect(isVerified(fake.deps.root, "1.10.1")).toBe(false);
  });
});

describe("unexpected errors", () => {
  test("before anything changed, the error surfaces (exit 1) and nothing is switched", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1"));
    fake.registry.tags.latest = "1.10.1";
    fake.deps.run = async () => { throw new TypeError("boom"); };
    await expect(runManualUpgrade(fake.deps, { installKind: "npm-global", to: "1.10.1" })).rejects.toThrow("boom");
    expect(readPointer(fake.deps.root)).toBeNull();
  });

  test("after the pointer moved, it is restored and reported as a rolled-back failure", async () => {
    const fake = fakeUpdater("1.10.0", registryWith("1.10.1"));
    fake.registry.tags.latest = "1.10.1";
    const run = fake.deps.run;
    let checks = 0;
    fake.deps.run = async (bin, args) => {
      if (bin === fake.deps.base.bin && checks++ === 0) throw new Error("spawn EAGAIN");
      return run(bin, args);
    };
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "failed-rolled-back", reason: "SWITCH_FAILED", current: "1.10.0", detail: "spawn EAGAIN" });
    expect(fake.active()).toBe("1.10.0");
  });
});

describe("telling the user", () => {
  test("the first-run notice shows once, only where automatic updates are on, and names the real versions directory and config file", () => {
    const fake = fakeUpdater("1.10.0");
    mkdirSync(fake.deps.root, { recursive: true });
    const config = join(fake.dir, ".tinycloud", "config.json");
    expect(takeAutoUpdateNotices(fake.deps.root, "1.10.0", false, config, fake.dir)).toEqual([]);
    expect(takeAutoUpdateNotices(fake.deps.root, "1.10.0", true, config, fake.dir)).toEqual([
      "TinyCloud CLI updates itself: it installs verified patch and minor releases of your channel in the background, 6 hours after your CLI first sees each one on your channel, and moves back if your channel moves back. Major releases are never installed automatically. Log: ~/versions/auto-update.log",
      "To turn this off, set \"autoUpdate\": false in ~/.tinycloud/config.json, or set TC_NO_AUTO_UPDATE=1.",
    ]);
    expect(takeAutoUpdateNotices(fake.deps.root, "1.10.0", true, config, fake.dir)).toEqual([]);
    // A TC_VERSIONS_DIR, or a TC_HOME config, outside the home directory is shown as it is.
    expect(firstRunNotice("/srv/tinycloud/versions", config, "/home/someone")[0]).toEndWith(" Log: /srv/tinycloud/versions/auto-update.log");
    expect(firstRunNotice("/home/someone-else/versions", config, "/home/someone")[0]).toEndWith(" Log: /home/someone-else/versions/auto-update.log");
    expect(firstRunNotice("/home/someone/versions", "/srv/state/.tinycloud/config.json", "/home/someone")[1]).toBe(
      "To turn this off, set \"autoUpdate\": false in /srv/state/.tinycloud/config.json, or set TC_NO_AUTO_UPDATE=1.",
    );
  });

  test("an automatic switch, and a follow-down, are each reported once by the version switched to; a manual upgrade clears it", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    mkdirSync(fake.deps.root, { recursive: true });
    writeFileSync(join(fake.deps.root, "first-run-notice.json"), "{}");
    await releaseAndSoak(fake, "1.9.6");
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.4", true)).toEqual([]);
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.6", true)).toEqual(["TinyCloud CLI updated to 1.9.6 (was 1.9.4)."]);
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.6", true)).toEqual([]);

    expect(await rollBackAndSoak(fake, "1.9.5")).toMatchObject({ action: "followed-down" });
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.5", true)).toEqual(["TinyCloud CLI moved back to 1.9.5 (was 1.9.6) because your channel moved back."]);

    expect(await rollBackAndSoak(fake, "1.9.4")).toMatchObject({ action: "followed-down" });
    fake.registry.tags.latest = "1.9.6";
    expect(await runManualUpgrade(fake.deps, { installKind: "npm-global" })).toMatchObject({ status: "ok", to: "1.9.6" });
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.4", true)).toEqual([]);
    expect(takeAutoUpdateNotices(fake.deps.root, "1.9.6", true)).toEqual([]);
  });
});
