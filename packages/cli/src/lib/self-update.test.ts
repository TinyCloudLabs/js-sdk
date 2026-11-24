import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeRegistry, OTHER_IDENTITY, fakeUpdater, type FakeUpdater } from "../test-support/self-update-fakes.js";
import { autoUpdateOffReason, pendingSwitch, runAutoUpdate, runManualUpgrade, SOAK_MS } from "./self-update.js";
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

describe("off switches", () => {
  const home = homedir();
  test("TC_NO_AUTO_UPDATE, CI and the config setting each turn automatic updates off", () => {
    expect(autoUpdateOffReason({ TC_NO_AUTO_UPDATE: "1" }, undefined, home)).toBe("env");
    expect(autoUpdateOffReason({ CI: "1" }, undefined, home)).toBe("ci");
    expect(autoUpdateOffReason({ CI: "true" }, undefined, home)).toBe("ci");
    expect(autoUpdateOffReason({}, { defaultProfile: "default", version: 1, autoUpdate: false }, home)).toBe("config");
    expect(autoUpdateOffReason({}, { defaultProfile: "default", version: 1 }, home)).toBeNull();
    expect(autoUpdateOffReason({}, undefined, home)).toBeNull();
  });

  test("a sandboxed TC_HOME turns them off unless TC_VERSIONS_DIR is set too", () => {
    expect(autoUpdateOffReason({ TC_HOME: "/tmp/qa-home" }, undefined, home)).toBe("sandbox");
    expect(autoUpdateOffReason({ TC_HOME: "/tmp/qa-home", TC_VERSIONS_DIR: "/tmp/qa-versions" }, undefined, home)).toBeNull();
    expect(autoUpdateOffReason({ TC_HOME: join(home, ".tinycloud") }, undefined, home)).toBeNull();
  });
});

describe("lock", () => {
  test("two updaters at once lead to one install", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5"));
    fake.registry.tags.latest = "1.9.5";
    await runAutoUpdate(fake.deps);
    fake.clock.now += SOAK_MS;
    const held = Promise.withResolvers<void>();
    fake.holdStage = held.promise;
    const staging = Promise.withResolvers<void>();
    fake.onStage = staging.resolve;
    const first = runAutoUpdate(fake.deps);
    await staging.promise;
    const second = await runAutoUpdate(fake.deps);
    held.resolve();
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

describe("following the tag down", () => {
  test("an automatically installed version follows a lower tag in the same major, without a soak", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    await releaseAndSoak(fake, "1.9.5");
    await releaseAndSoak(fake, "1.9.6");
    fake.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "followed-down", version: "1.9.5", from: "1.9.6" });
    expect(fake.active()).toBe("1.9.5");

    fake.registry.tags.latest = "1.9.4";
    expect(await runAutoUpdate(fake.deps)).toEqual({ action: "followed-down", version: "1.9.4", from: "1.9.5" });
    expect(fake.active()).toBe("1.9.4");
  });

  test("a rolled-back tag that fails verification is not followed", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.6"));
    fake.registry.publish("@tinycloud/cli", "1.9.5", { attested: false });
    await releaseAndSoak(fake, "1.9.6");
    fake.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(fake.deps)).toMatchObject({ action: "failed", result: { reason: "PROVENANCE_MISSING" } });
    expect(fake.active()).toBe("1.9.6");
  });

  test("manual and pinned installs don't follow the tag down, and no tag crosses a major", async () => {
    const manual = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    manual.registry.tags.latest = "1.9.6";
    await runManualUpgrade(manual.deps, { installKind: "npm-global" });
    manual.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(manual.deps)).toEqual({ action: "none" });
    expect(manual.active()).toBe("1.9.6");

    const pinned = fakeUpdater("1.9.4", registryWith("1.9.6"));
    await runManualUpgrade(pinned.deps, { installKind: "npm-global", to: "1.9.6" });
    pinned.registry.tags.latest = "1.9.5";
    expect(await runAutoUpdate(pinned.deps)).toEqual({ action: "pinned", version: "1.9.6" });

    const major = fakeUpdater("2.0.0", registryWith("2.0.1"));
    await releaseAndSoak(major, "2.0.1");
    major.registry.tags.latest = "1.9.9";
    expect(await runAutoUpdate(major.deps)).toEqual({ action: "none" });
    expect(major.active()).toBe("2.0.1");
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

  test("--to pins an exact version (down too), a plain upgrade unpins, and --to below 1.9.4 refuses", async () => {
    const fake = fakeUpdater("1.9.4", registryWith("1.9.5", "1.9.6"));
    fake.registry.tags.latest = "1.9.6";
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global" })).toMatchObject({ status: "ok", to: "1.9.6" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.9.5" })).toMatchObject({ status: "ok", from: "1.9.6", to: "1.9.5", changed: true });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.9.5", pinned: true });
    fake.registry.tags.latest = "1.9.5";
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global" })).toMatchObject({ status: "ok", changed: false });
    expect(readPointer(fake.deps.root)).toMatchObject({ version: "1.9.5", pinned: false });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.9.3" })).toMatchObject({ status: "refused", reason: "TARGET_TOO_OLD" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "latest" })).toMatchObject({ status: "refused", reason: "INVALID_VERSION" });
    expect(await runManualUpgrade(fake.deps, { installKind: "bun-global", to: "1.9.9" })).toMatchObject({ status: "refused", reason: "VERSION_NOT_FOUND" });
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
});
