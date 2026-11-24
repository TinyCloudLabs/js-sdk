import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireReleaseProvenance, VerificationError } from "../src/lib/provenance.js";
import { BUNDLES, COURIER, COURIER_STAGE, offlineVerifier } from "../src/test-support/offline-sigstore.js";
import { FakeRegistry, integrityOf } from "../src/test-support/self-update-fakes.js";
import {
  bunRuntimeTree,
  checkShrinkwrap,
  generateShrinkwrap,
  MISSING_PROVENANCE_RETRY_MS,
  parseBunLock,
  readUnattested,
  registryTarball,
  retryingMissingProvenance,
  tinycloudProvenanceProblems,
  versionsWithoutShrinkwrap,
  yarnLockFor,
} from "./release-shrinkwrap.mjs";

const sha = (label: string) => `sha512-${label}==`;

// A workspace whose CLI requires a workspace SDK and third-party packages, with a nested copy, an optional peer bun
// linked anyway, an optional dependency bun did not install, and dev dependencies.
function lockFixture(overrides: { packages?: Record<string, unknown[]>; cli?: Record<string, unknown> } = {}) {
  return {
    lockfileVersion: 1,
    workspaces: {
      "": { name: "root", devDependencies: { typescript: "5.7.3" } },
      "packages/cli": {
        name: "@tinycloud/cli",
        version: "1.2.0",
        dependencies: { "@tinycloud/sdk": "3.0.0", chalk: "^5.3.0", ora: "^9.0.0" },
        optionalDependencies: { fsevents: "^2.3.0" },
        devDependencies: { tsup: "^8.0.0" },
        ...overrides.cli,
      },
      "packages/sdk": { name: "@tinycloud/sdk", version: "3.0.0", dependencies: { chalk: "^4.1.0", ws: "^8.0.0" } },
    },
    packages: {
      "@tinycloud/cli": ["@tinycloud/cli@workspace:packages/cli"],
      "@tinycloud/sdk": ["@tinycloud/sdk@workspace:packages/sdk"],
      chalk: ["chalk@5.3.0", "", {}, sha("chalk5")],
      "@tinycloud/sdk/chalk": ["chalk@4.1.2", "", { dependencies: { "ansi-styles": "^4.1.0" } }, sha("chalk4")],
      "ansi-styles": ["ansi-styles@4.3.0", "", {}, sha("ansi")],
      ora: ["ora@9.0.0", "", { dependencies: { chalk: "^5.0.0" } }, sha("ora")],
      ws: ["ws@8.18.0", "", { peerDependencies: { bufferutil: "^4.0.1" }, optionalPeers: ["bufferutil"] }, sha("ws")],
      bufferutil: ["bufferutil@4.0.9", "", {}, sha("bufferutil")],
      tsup: ["tsup@8.0.0", "", {}, sha("tsup")],
      typescript: ["typescript@5.7.3", "", {}, sha("ts")],
      ...overrides.packages,
    },
  };
}

const entry = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: registryTarball(name, version),
  integrity: sha(extra.label as string ?? name),
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "label")),
});

// What npm writes for lockFixture's CLI.
function npmLock() {
  return {
    name: "@tinycloud/cli",
    version: "1.2.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "@tinycloud/cli", version: "1.2.0", dependencies: { "@tinycloud/sdk": "3.0.0", chalk: "^5.3.0", ora: "^9.0.0" } },
      "node_modules/@tinycloud/sdk": entry("@tinycloud/sdk", "3.0.0", { label: "anything-npm-says" }),
      "node_modules/@tinycloud/sdk/node_modules/chalk": entry("chalk", "4.1.2", { label: "chalk4" }),
      "node_modules/ansi-styles": entry("ansi-styles", "4.3.0", { label: "ansi" }),
      "node_modules/chalk": entry("chalk", "5.3.0", { label: "chalk5" }),
      "node_modules/ora": entry("ora", "9.0.0", { label: "ora" }),
      "node_modules/ws": entry("ws", "8.18.0", { label: "ws" }),
    },
  };
}

const manifest = { name: "@tinycloud/cli", version: "1.2.0" };

describe("parseBunLock", () => {
  test("drops trailing commas outside strings only", () => {
    expect(parseBunLock('{ "a": [1, 2,], "b": { "c": "x,}", }, }')).toEqual({ a: [1, 2], b: { c: "x,}" } });
    expect(parseBunLock('{ "a": "quote \\" ,]", }')).toEqual({ a: 'quote " ,]' });
  });
});

describe("bunRuntimeTree", () => {
  test("follows bun's install paths through workspace packages, nested copies and optional dependencies", () => {
    const tree = bunRuntimeTree(lockFixture(), "@tinycloud/cli");
    expect(Object.fromEntries([...tree.hints].map(([hint, { version }]) => [hint, version]))).toEqual({
      "chalk@^5.3.0": "5.3.0",
      "chalk@^5.0.0": "5.3.0",
      "ora@^9.0.0": "9.0.0",
      "chalk@^4.1.0": "4.1.2",
      "ansi-styles@^4.1.0": "4.3.0",
      "ws@^8.0.0": "8.18.0",
    });
    // The optional peer bun linked, the optional dependency bun skipped, and dev dependencies stay out.
    expect([...tree.packages.keys()].sort()).toEqual(["ansi-styles@4.3.0", "chalk@4.1.2", "chalk@5.3.0", "ora@9.0.0", "ws@8.18.0"]);
    expect(tree.packages.get("chalk@4.1.2")).toBe(sha("chalk4"));
    expect(Object.fromEntries(tree.workspaces)).toEqual({ "@tinycloud/cli": "1.2.0", "@tinycloud/sdk": "3.0.0" });
  });

  test("refuses what a registry shrinkwrap cannot pin", () => {
    const tree = (overrides: Parameters<typeof lockFixture>[0]) => () => bunRuntimeTree(lockFixture(overrides), "@tinycloud/cli");
    expect(tree({ packages: { ora: ["ora@9.0.0", "https://npm.example.com/", {}, sha("ora")] } })).toThrow("does not come from the npm registry");
    expect(tree({ packages: { ora: ["ora@9.0.0", "", {}] } })).toThrow("no sha512 integrity");
    expect(tree({ packages: { ora: ["other-ora@9.0.0", "", {}, sha("ora")] } })).toThrow("alias");
    expect(tree({ cli: { dependencies: { "@tinycloud/sdk": "2.9.0" } } })).toThrow("the workspace package is 3.0.0");
    expect(tree({ cli: { dependencies: { missing: "^1.0.0" } } })).toThrow("bun.lock does not resolve missing@^1.0.0");
    // Two installs of the same request at different versions cannot both be handed to npm.
    expect(tree({
      cli: { dependencies: { "@tinycloud/sdk": "3.0.0", chalk: "^5.3.0", ora: "^9.0.0", ws: "^8.0.0" } },
      packages: { "@tinycloud/cli/ws": ["ws@8.19.0", "", {}, sha("ws19")] },
    })).toThrow("bun.lock resolves ws@^8.0.0 to both");
    expect(() => bunRuntimeTree(lockFixture(), "@tinycloud/nope")).toThrow("no workspace package");
  });
});

test("yarnLockFor writes one yarn v1 entry per request, pointing at the registry tarball", () => {
  const text = yarnLockFor(new Map([
    ["ora@^9.0.0", { name: "ora", version: "9.0.0", integrity: sha("ora") }],
    ["@scope/pkg@>=1 <2", { name: "@scope/pkg", version: "1.5.0", integrity: sha("pkg") }],
  ]));
  expect(text).toBe([
    "# yarn lockfile v1",
    "",
    '"@scope/pkg@>=1 <2":',
    '  version "1.5.0"',
    '  resolved "https://registry.npmjs.org/@scope/pkg/-/pkg-1.5.0.tgz"',
    `  integrity ${sha("pkg")}`,
    "",
    '"ora@^9.0.0":',
    '  version "9.0.0"',
    '  resolved "https://registry.npmjs.org/ora/-/ora-9.0.0.tgz"',
    `  integrity ${sha("ora")}`,
    "",
    "",
  ].join("\n"));
});

describe("checkShrinkwrap", () => {
  const tree = () => bunRuntimeTree(lockFixture(), "@tinycloud/cli");

  test("accepts npm's layout of exactly the bun.lock packages", () => {
    expect(checkShrinkwrap(npmLock(), manifest, tree())).toEqual({ problems: [], unused: [] });
  });

  test("reports a bun.lock package npm did not need as unused, not as a problem", () => {
    const lock = npmLock();
    delete (lock.packages as Record<string, unknown>)["node_modules/ws"];
    expect(checkShrinkwrap(lock, manifest, tree())).toEqual({ problems: [], unused: ["ws@8.18.0"] });
  });

  test("refuses entries that are not the tested registry packages", () => {
    const lock = npmLock() as { lockfileVersion: number; packages: Record<string, Record<string, unknown>> };
    lock.lockfileVersion = 2;
    lock.packages[""] = { name: "@tinycloud/cli", version: "1.1.0" };
    lock.packages["node_modules/ora"] = entry("ora", "9.1.0", { label: "ora" });
    lock.packages["node_modules/chalk"] = entry("chalk", "5.3.0", { label: "tampered" });
    lock.packages["node_modules/ws"] = { ...entry("ws", "8.18.0", { label: "ws" }), resolved: "https://mirror.example.com/ws/-/ws-8.18.0.tgz" };
    lock.packages["node_modules/@tinycloud/sdk"] = entry("@tinycloud/sdk", "2.9.0");
    lock.packages["node_modules/@tinycloud/other"] = entry("@tinycloud/other", "1.0.0");
    lock.packages["node_modules/local"] = { resolved: "packages/local", link: true };
    lock.packages["node_modules/aliased"] = { ...entry("ora", "9.0.0", { label: "ora" }), name: "ora" };
    lock.packages["node_modules/tsup"] = entry("tsup", "8.0.0", { label: "tsup", dev: true });
    lock.packages["node_modules/ora/node_modules/inner"] = { version: "1.0.0", inBundle: true };
    lock.packages["node_modules/nohash"] = { version: "1.0.0", resolved: registryTarball("nohash", "1.0.0") };
    expect(checkShrinkwrap(lock, manifest, tree()).problems).toEqual([
      "lockfileVersion is 2, not 3",
      "the root entry is @tinycloud/cli@1.1.0, not @tinycloud/cli@1.2.0",
      "node_modules/@tinycloud/sdk is 2.9.0, but this commit releases @tinycloud/sdk@3.0.0",
      "chalk@5.3.0 (node_modules/chalk) has integrity sha512-tampered==, bun.lock has sha512-chalk5==",
      "ora@9.1.0 (node_modules/ora) is not the version bun.lock installs",
      "node_modules/ws resolves to https://mirror.example.com/ws/-/ws-8.18.0.tgz, not https://registry.npmjs.org/ws/-/ws-8.18.0.tgz",
      "node_modules/@tinycloud/other is a TinyCloud package bun.lock does not link into the CLI's tree",
      "node_modules/local is not a plain registry package",
      "node_modules/aliased is not a plain registry package",
      "node_modules/tsup is not a runtime dependency",
      "tsup@8.0.0 (node_modules/tsup) is not the version bun.lock installs",
      "inner@1.0.0 (node_modules/ora/node_modules/inner) is in ora's bundleDependencies: npm installs it from ora's tarball, so the shrinkwrap can't pin it and the updater can't check its npm signature. Replace ora, or use a version of it that doesn't bundle dependencies",
      "node_modules/nohash has no sha512 integrity",
      "nohash@1.0.0 (node_modules/nohash) is not the version bun.lock installs",
    ]);
  });
});

describe("generateShrinkwrap", () => {
  // A stand-in npm: records its arguments, environment and the yarn.lock it was given, and writes `lock`.
  function workspace(lock: unknown) {
    const root = mkdtempSync(join(tmpdir(), "release-shrinkwrap-"));
    const packageDir = join(root, "packages/cli");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(root, "bun.lock"), `${JSON.stringify(lockFixture(), null, 2).replace(/\n(\s*)([}\]])/g, ",\n$1$2")}\n`);
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      ...manifest,
      license: "EGPL",
      bin: { tc: "./bin/tinycloud" },
      engines: { node: ">=20" },
      scripts: { prepack: "node scripts/release-shrinkwrap.mjs prepack" },
      dependencies: { "@tinycloud/sdk": "3.0.0", chalk: "^5.3.0", ora: "^9.0.0" },
      devDependencies: { tsup: "^8.0.0" },
    }));
    const record = join(root, "npm-call.json");
    const npm = join(root, "fake-npm.mjs");
    writeFileSync(npm, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env), cwd: process.cwd(), yarnLock: readFileSync("yarn.lock", "utf8"), packageJson: JSON.parse(readFileSync("package.json", "utf8")) }));
writeFileSync("package-lock.json", ${JSON.stringify(JSON.stringify(lock, null, 2))});
`);
    chmodSync(npm, 0o755);
    return { root, packageDir, npm, record, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("hands npm bun.lock's resolutions without npm's lifecycle config, and writes the checked lockfile", () => {
    const ws = workspace(npmLock());
    try {
      const out = join(ws.root, "npm-shrinkwrap.json");
      const lines: string[] = [];
      generateShrinkwrap({
        packageDir: ws.packageDir,
        repoDir: ws.root,
        out,
        npm: ws.npm,
        env: { ...process.env, npm_config_dry_run: "true", NPM_CONFIG_JSON: "true", npm_command: "publish" },
        log: (line: string) => lines.push(line),
      });
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(npmLock());
      const call = JSON.parse(readFileSync(ws.record, "utf8"));
      expect(call.args).toEqual(["install", "--package-lock-only", "--lockfile-version=3", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", "--registry=https://registry.npmjs.org/"]);
      expect(call.env.filter((key: string) => /^npm_/i.test(key))).toEqual([]);
      expect(call.yarnLock).toContain('"ora@^9.0.0":\n  version "9.0.0"');
      // Only what the published package installs: no dev dependencies, no lifecycle scripts.
      expect(call.packageJson).toEqual({
        name: "@tinycloud/cli",
        version: "1.2.0",
        license: "EGPL",
        bin: { tc: "./bin/tinycloud" },
        engines: { node: ">=20" },
        dependencies: { "@tinycloud/sdk": "3.0.0", chalk: "^5.3.0", ora: "^9.0.0" },
      });
      expect(existsSync(call.cwd)).toBe(false);
      expect(lines.at(-1)).toBe(`release-shrinkwrap: wrote ${out} (6 packages)`);
    } finally {
      ws.cleanup();
    }
  });

  test("writes nothing when npm's tree is not the tested one", () => {
    const lock = npmLock();
    lock.packages["node_modules/ora"] = entry("ora", "9.1.0", { label: "ora" });
    const ws = workspace(lock);
    try {
      const out = join(ws.root, "npm-shrinkwrap.json");
      expect(() => generateShrinkwrap({ packageDir: ws.packageDir, repoDir: ws.root, out, npm: ws.npm, log: () => {} }))
        .toThrow("ora@9.1.0 (node_modules/ora) is not the version bun.lock installs");
      expect(existsSync(out)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

describe("lifecycle", () => {
  // The script resolves the package from its own location, so run a copy inside a scratch package.
  function scratchPackage() {
    const root = mkdtempSync(join(tmpdir(), "release-shrinkwrap-life-"));
    mkdirSync(join(root, "packages/cli/scripts"), { recursive: true });
    copyFileSync(join(import.meta.dir, "release-shrinkwrap.mjs"), join(root, "packages/cli/scripts/release-shrinkwrap.mjs"));
    return root;
  }
  const run = (root: string, mode: string, npmCommand: string) => spawnSync("node", [join(root, "packages/cli/scripts/release-shrinkwrap.mjs"), mode], {
    env: { ...process.env, npm_command: npmCommand },
    encoding: "utf8",
  });

  test("a pack that is not a publish does nothing", () => {
    const root = scratchPackage();
    try {
      // No bun.lock and no package.json: generating would fail.
      const result = run(root, "prepack", "pack");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(join(root, "packages/cli/npm-shrinkwrap.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a publish that cannot generate fails, and postpack removes the shrinkwrap", () => {
    const root = scratchPackage();
    try {
      const failed = run(root, "prepack", "publish");
      expect(failed.status).toBe(1);
      expect(failed.stderr).toStartWith("release-shrinkwrap: ");
      writeFileSync(join(root, "packages/cli/npm-shrinkwrap.json"), "{}\n");
      expect(run(root, "postpack", "pack").status).toBe(0);
      expect(existsSync(join(root, "packages/cli/npm-shrinkwrap.json"))).toBe(true);
      expect(run(root, "postpack", "publish").status).toBe(0);
      expect(existsSync(join(root, "packages/cli/npm-shrinkwrap.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("versionsWithoutShrinkwrap flags each published CLI version npm does not mark _hasShrinkwrap", async () => {
  const docs: Record<string, { status: number; body?: unknown }> = {
    "https://registry.npmjs.org/@tinycloud/cli/1.3.0": { status: 200, body: { version: "1.3.0", _hasShrinkwrap: true } },
    "https://registry.npmjs.org/@tinycloud/cli/1.3.1": { status: 200, body: { version: "1.3.1", _hasShrinkwrap: false } },
    "https://registry.npmjs.org/@tinycloud/cli/1.3.2": { status: 404 },
  };
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    const { status, body } = docs[url] ?? { status: 500 };
    return { status, json: async () => body };
  };
  const accepted = new Set(["@tinycloud/sdk-core@3.0.0", "@tinycloud/cli@1.3.0", "@tinycloud/cli@1.3.1", "@tinycloud/cli@1.3.2", "@tinycloud/cli-tests@1.0.0"]);
  expect(await versionsWithoutShrinkwrap(accepted, "@tinycloud/cli", fetchFn)).toEqual([
    "@tinycloud/cli@1.3.1 (_hasShrinkwrap is false)",
    "@tinycloud/cli@1.3.2 (registry answered 404)",
  ]);
  expect(requested).toEqual(Object.keys(docs));
});

describe("every @tinycloud package the CLI pins needs the Release workflow's provenance or a listed exact match (F1 (b))", () => {
  const id = (pkg: { name: string; version: string }) => `${pkg.name}@${pkg.version}`;
  const attestation = (pkg: { name: string; version: string }) => [{ predicateType: "https://slsa.dev/provenance/v1", bundle: BUNDLES.get(id(pkg)) }];
  const envelope = { name: "@tinycloud/share-envelope", version: "1.6.0", integrity: integrityOf("@tinycloud/share-envelope", "1.6.0") };
  // The prepack's check (requireReleaseProvenance: the updater's Release identity) on real npm provenance: courier
  // 0.8.2 is signed by the Release workflow, 0.8.1 by courier-stable-stage.yml; share-envelope 1.6.0 is unattested
  // and listed.
  function setup() {
    const registry = new FakeRegistry();
    const real = new Map([[id(COURIER), COURIER.integrity], [id(COURIER_STAGE), COURIER_STAGE.integrity]]);
    registry.integrity = (name: string, version: string) => real.get(`${name}@${version}`) ?? integrityOf(name, version);
    for (const pkg of [COURIER, COURIER_STAGE]) {
      registry.publish(pkg.name, pkg.version);
      registry.attestationsById.set(id(pkg), attestation(pkg));
    }
    registry.publish(envelope.name, envelope.version, { attested: false });
    const verified: string[] = [];
    const verify = (name: string, version: string, integrity: string) => {
      verified.push(`${name}@${version}`);
      return requireReleaseProvenance(registry, offlineVerifier, name, version, integrity);
    };
    const unattested = new Map([[id(envelope), envelope.integrity]]);
    return { registry, verify, verified, unattested };
  }
  const lockOf = (...pkgs: { name: string; version: string; integrity: string }[]) => ({
    lockfileVersion: 3,
    packages: {
      "": { name: "@tinycloud/cli", version: "1.10.1" },
      "node_modules/chalk": { version: "5.3.0", integrity: integrityOf("chalk", "5.3.0") },
      ...Object.fromEntries(pkgs.map((pkg) => [`node_modules/${pkg.name}`, { version: pkg.version, integrity: pkg.integrity }])),
    },
  });

  test("a Release-attested version and a listed exact match pass; the listed one isn't looked up", async () => {
    const { verify, verified, unattested } = setup();
    expect(await tinycloudProvenanceProblems(lockOf(COURIER, envelope), unattested, verify)).toEqual({ problems: [], attested: [id(COURIER)], listed: [id(envelope)] });
    expect(verified).toEqual([id(COURIER)]);
  });

  test("a half-finished release can't be finished by someone else: the unattested version it left pinned fails", async () => {
    // Release N bumped sdk-core to 3.15.0 and the CLI, then stopped before publishing them. Someone else published an
    // unattested sdk-core 3.15.0 (and a throwaway CLI). Release N+1 bumps only the CLI, whose shrinkwrap pins it.
    const { registry, verify, unattested } = setup();
    registry.publish("@tinycloud/sdk-core", "3.15.0", { attested: false });
    const sdkCore = { name: "@tinycloud/sdk-core", version: "3.15.0", integrity: integrityOf("@tinycloud/sdk-core", "3.15.0") };
    expect(await tinycloudProvenanceProblems(lockOf(COURIER, envelope, sdkCore), unattested, verify)).toEqual({
      problems: [
        "@tinycloud/sdk-core@3.15.0 has no provenance from the Release workflow and is not listed as unattested: PROVENANCE_MISSING: @tinycloud/sdk-core@3.15.0: no provenance attestation",
      ],
      attested: [id(COURIER)],
      listed: [id(envelope)],
    });
  });

  test("a version signed by another workflow (courier-stable-stage.yml) fails", async () => {
    const { verify, unattested } = setup();
    expect((await tinycloudProvenanceProblems(lockOf(COURIER_STAGE), unattested, verify)).problems).toEqual([
      `${id(COURIER_STAGE)} has no provenance from the Release workflow and is not listed as unattested: PROVENANCE_INVALID: ${id(COURIER_STAGE)}: provenance signed by "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/courier-stable-stage.yml@refs/heads/master", not the Release workflow`,
    ]);
  });

  test("a listed version whose integrity differs fails, and so does an attested one npm serves with another integrity", async () => {
    const { verify, verified, unattested } = setup();
    const other = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    expect((await tinycloudProvenanceProblems(lockOf({ ...envelope, integrity: other }, { ...COURIER, integrity: other }), unattested, verify)).problems).toEqual([
      `${id(envelope)} is listed as unattested with ${envelope.integrity}, but the shrinkwrap pins ${other}`,
      `${id(COURIER)} has no provenance from the Release workflow and is not listed as unattested: PROVENANCE_INVALID: ${id(COURIER)}: npm serves ${COURIER.integrity}, not the pinned ${other}`,
    ]);
    expect(verified).toEqual([id(COURIER)]);
  });

  test("a missing attestation is retried with backoff for at most 2 minutes; any other refusal is final", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
    const failing = (code: "PROVENANCE_MISSING" | "PROVENANCE_INVALID", times: number) => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls <= times) throw new VerificationError(code, "@tinycloud/sdk-core@3.15.0", "refused");
        return calls;
      };
    };
    // npm serves the attestation on the third look.
    expect(await retryingMissingProvenance(failing("PROVENANCE_MISSING", 2), clock)()).toBe(3);
    expect(sleeps).toEqual([5000, 10000]);
    // Never served: the publish fails once the 2 minutes are spent.
    sleeps.length = 0;
    await expect(retryingMissingProvenance(failing("PROVENANCE_MISSING", Infinity), clock)()).rejects.toMatchObject({ code: "PROVENANCE_MISSING" });
    expect(sleeps).toEqual([5000, 10000, 20000, 40000, 45000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(MISSING_PROVENANCE_RETRY_MS);
    // An invalid attestation is not retried.
    sleeps.length = 0;
    await expect(retryingMissingProvenance(failing("PROVENANCE_INVALID", 1), clock)()).rejects.toMatchObject({ code: "PROVENANCE_INVALID" });
    expect(sleeps).toEqual([]);
  });

  test("the committed list holds only exact sha512 pins of versions published before 24 Nov 2026, each with its reason", () => {
    const file = JSON.parse(readFileSync(new URL("./unattested-tinycloud-versions.json", import.meta.url), "utf8")) as { versions: Record<string, { integrity: string; published: string; source: string }> };
    const entries = Object.entries(file.versions);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      expect(key).toMatch(/^@tinycloud\/[a-z0-9-]+@\d+\.\d+\.\d+$/);
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(Date.parse(entry.published)).toBeLessThan(Date.parse("2026-11-24T00:00:00Z"));
      expect(entry.source.length).toBeGreaterThan(0);
    }
    expect(readUnattested()).toEqual(new Map(entries.map(([key, entry]) => [key, entry.integrity])));
  });
});
