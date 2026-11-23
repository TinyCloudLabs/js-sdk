import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildFilters,
  planFlags,
  requiredFiles,
  guardRoute,
  guardRouteHead,
  ROOT_NPMRC,
  loadPlan,
  npmrcProblems,
  publish,
  publishLayers,
  runtimePinProblems,
  sealProblems,
  stabilizeManifest,
  tarballProblems,
  verifyReleaseCommit,
  verifyTarballs,
} from "./courier-stable-stage.mjs";

const policy = JSON.parse(readFileSync(new URL("./courier-stable-stage-plans.json", import.meta.url), "utf8"));
const BASE = "a0b24da8f04d674e651558d6f11376ce1ddb4def";
const RELEASE = "b".repeat(40);
const real = loadPlan("courier-0.8.0");
const nine = real.packages;
const pkgOf = (name) => real.byName.get(name);

// A plan of the real shape (nine packages) over fixture commits.
const fixturePlan = ({ base = BASE, sourceSha = base, releaseSha = RELEASE, expectedDelta } = {}) =>
  loadPlan("fixture", { ...policy, plans: { fixture: { ...policy.plans["courier-0.8.0"], base, sourceSha, releaseSha, expectedDelta: expectedDelta ?? policy.plans["courier-0.8.0"].expectedDelta } } });

// The nine manifests as they are at the base: exact beta pins between them, share pair stable.
const sourceManifest = (pkg) => {
  const dependencies = {};
  const devDependencies = {};
  const wire = {
    "@tinycloud/sdk-services": ["@tinycloud/bootstrap"],
    "@tinycloud/sdk-core": ["@tinycloud/bootstrap", "@tinycloud/sdk-services"],
    "@tinycloud/replica": ["@tinycloud/sdk-services"],
    "@tinycloud/node-sdk": ["@tinycloud/replica", "@tinycloud/sdk-services", "@tinycloud/sdk-core", "@tinycloud/node-sdk-wasm"],
    "@tinycloud/operations": ["@tinycloud/node-sdk", "@tinycloud/sdk-core", "@tinycloud/sdk-services"],
    "@tinycloud/courier": ["@tinycloud/node-sdk", "@tinycloud/sdk-core"],
    "@tinycloud/cli": ["@tinycloud/node-sdk", "@tinycloud/node-sdk-wasm", "@tinycloud/sdk-core", "@tinycloud/sdk-services", "@tinycloud/operations"],
  };
  for (const dep of wire[pkg.name] ?? []) dependencies[dep] = pkgOf(dep).from;
  if (["@tinycloud/sdk-core", "@tinycloud/node-sdk", "@tinycloud/courier", "@tinycloud/cli"].includes(pkg.name)) Object.assign(dependencies, real.sharePair);
  dependencies.zod = "^3.23.0";
  if (pkg.name === "@tinycloud/sdk-services") devDependencies["@tinycloud/node-sdk-wasm"] = pkgOf("@tinycloud/node-sdk-wasm").from;
  if (pkg.name === "@tinycloud/replica") devDependencies["@tinycloud/web-sdk-wasm"] = "1.8.0-beta.0";
  if (pkg.name === "@tinycloud/cli") Object.assign(devDependencies, { "@tinycloud/courier": pkgOf("@tinycloud/courier").from, "@tinycloud/replica": pkgOf("@tinycloud/replica").from });
  return { name: pkg.name, version: pkg.from, main: "dist/index.js", files: ["dist"], scripts: { build: "tsup" }, dependencies, devDependencies };
};
const stableManifest = (pkg, plan = real) => stabilizeManifest(sourceManifest(pkg), pkg, plan);

// ---- the sealed plans ----------------------------------------------------------------------------------------------

test("the 0.8.0 plan is sealed to the approved nine packages and stable versions, staging tag only", () => {
  assert.deepEqual(sealProblems(real), []);
  assert.equal(real.base, BASE);
  assert.match(real.releaseSha, /^[0-9a-f]{40}$/);
  assert.equal(real.tag, "staging");
  assert.deepEqual(Object.fromEntries(nine.map((pkg) => [pkg.name, pkg.stable])), {
    "@tinycloud/bootstrap": "2.10.0",
    "@tinycloud/node-sdk-wasm": "1.8.0",
    "@tinycloud/sdk-services": "3.14.0",
    "@tinycloud/sdk-core": "3.14.0",
    "@tinycloud/node-sdk": "3.14.0",
    "@tinycloud/replica": "0.4.7",
    "@tinycloud/operations": "0.10.0",
    "@tinycloud/courier": "0.8.0",
    "@tinycloud/cli": "1.9.0",
  });
  assert.deepEqual(real.sharePair, { "@tinycloud/share-sdk": "1.6.0", "@tinycloud/share-envelope": "1.6.0" });
  assert.deepEqual(real.expectedDelta.filter((path) => !path.endsWith("/package.json")), ["bun.lock"]);
  assert.equal(real.expectedDelta.length, nine.length + 1);
});

test("the 0.8.1 plan stays closed until its release commit and exact delta are sealed", () => {
  const plan = loadPlan("courier-0.8.1");
  assert.match(sealProblems(plan).join("\n"), /releaseSha is null/);
  assert.match(sealProblems(plan).join("\n"), /expectedDelta/);
  assert.deepEqual(plan.packages.map((pkg) => `${pkg.name}@${pkg.stable}`), ["@tinycloud/courier@0.8.1"]);
  assert.equal(plan.allowedRuntime.get("@tinycloud/sdk-core"), "3.14.0");
  assert.equal(plan.allowedRuntime.has("@tinycloud/cli"), false);
});

test("only plan ids the policy file defines are accepted", () => {
  for (const id of ["", undefined, "latest", "courier-0.8.0 ", "__proto__", "constructor", "../x"]) assert.throws(() => loadPlan(id), /unknown plan/);
  assert.throws(() => loadPlan("courier-0.8.0", { ...policy, tag: "latest" }), /not staging/);
});

test("builds cover the plan's packages and what they build from, minus the exclusions", () => {
  assert.deepEqual(buildFilters(loadPlan("courier-0.8.1")), ["--filter=@tinycloud/courier...", "--filter=!@tinycloud/web-sdk"]);
  assert.equal(buildFilters(real).length, nine.length + 1);
});

// ---- route guard ---------------------------------------------------------------------------------------------------

const routeEnv = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master", GITHUB_SHA: "route" };
const fakeRepo = (overrides = {}) => ({ revParse: (rev) => (rev === "HEAD" ? "route" : rev), isAncestor: () => true, ...overrides });

test("a dispatch on master at a master commit with a sealed plan passes the head guard", () => {
  assert.deepEqual(guardRouteHead({ env: routeEnv, repo: fakeRepo(), masterTip: "tip", plan: real }), []);
});

test("the head guard refuses other events, other refs, another checkout, off-master commits and unsealed plans", () => {
  const problems = guardRouteHead({ env: { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/x", GITHUB_SHA: "other" }, repo: fakeRepo({ isAncestor: () => false }), masterTip: "tip", plan: real }).join("\n");
  assert.match(problems, /not workflow_dispatch/);
  assert.match(problems, /not refs\/heads\/master/);
  assert.match(problems, /is not the dispatched commit/);
  assert.match(problems, /is not on master/);
  assert.match(guardRouteHead({ env: routeEnv, repo: fakeRepo(), masterTip: "tip", plan: loadPlan("courier-0.8.1") }).join("\n"), /not sealed/);
});

test("the route guard refuses a release commit that is not in the checkout", () => {
  const repo = fakeRepo({ isAncestor: (a) => a !== real.releaseSha });
  assert.match(guardRoute({ env: routeEnv, repo, masterTip: "tip", plan: real, git: () => "" }).join("\n"), /not available in the checkout/);
});

// ---- version-only edit ---------------------------------------------------------------------------------------------

test("stabilizing rewrites the version and the plan's pins, and nothing else", () => {
  const cli = pkgOf("@tinycloud/cli");
  const before = sourceManifest(cli);
  const after = stabilizeManifest(before, cli, real);
  assert.equal(after.version, "1.9.0");
  assert.equal(after.dependencies["@tinycloud/operations"], "0.10.0");
  assert.equal(after.dependencies["@tinycloud/node-sdk-wasm"], "1.8.0");
  assert.equal(after.devDependencies["@tinycloud/courier"], "0.8.0");
  assert.equal(after.devDependencies["@tinycloud/web-sdk-wasm"], undefined);
  assert.equal(after.dependencies["@tinycloud/share-sdk"], "1.6.0");
  assert.equal(after.dependencies.zod, "^3.23.0");
  assert.deepEqual(runtimePinProblems(after, real), []);
  assert.equal(before.version, "1.9.0-beta.20", "input is not mutated");
});

test("a backport plan rewrites its pins to the stable versions already on npm", () => {
  const plan = loadPlan("courier-0.8.1");
  const courier = plan.packages[0];
  const after = stabilizeManifest(sourceManifest(courier), courier, plan);
  assert.equal(after.version, "0.8.1");
  assert.equal(after.dependencies["@tinycloud/node-sdk"], "3.14.0");
  assert.equal(after.dependencies["@tinycloud/sdk-core"], "3.14.0");
  assert.deepEqual(runtimePinProblems(after, plan), []);
});

test("stabilizing refuses a pin or version that is not the base's", () => {
  const cli = pkgOf("@tinycloud/cli");
  const manifest = sourceManifest(cli);
  manifest.dependencies["@tinycloud/sdk-core"] = "3.14.0-beta.21";
  assert.throws(() => stabilizeManifest(manifest, cli, real), /not the source version 3\.14\.0-beta\.20/);
  assert.throws(() => stabilizeManifest({ ...sourceManifest(cli), version: "1.9.0-beta.21" }, cli, real), /expected @tinycloud\/cli@1\.9\.0-beta\.20/);
});

test("runtime pins refuse nested betas, ranges, unknown @tinycloud packages and lifecycle scripts", () => {
  const base = stableManifest(pkgOf("@tinycloud/node-sdk"));
  assert.deepEqual(runtimePinProblems(base, real), []);
  const withDep = (name, spec) => ({ ...base, dependencies: { ...base.dependencies, [name]: spec } });
  assert.match(runtimePinProblems(withDep("@tinycloud/sdk-core", "3.14.0-beta.20"), real).join(), /expected exactly "3\.14\.0"/);
  assert.match(runtimePinProblems(withDep("@tinycloud/sdk-core", "^3.14.0"), real).join(), /expected exactly/);
  assert.match(runtimePinProblems(withDep("@tinycloud/mcp", "0.12.0"), real).join(), /not allowed by plan/);
  assert.match(runtimePinProblems(withDep("@tinycloud/web-sdk-wasm", "1.8.0"), real).join(), /not allowed by plan/);
  assert.match(runtimePinProblems(withDep("zod", "workspace:*"), real).join(), /non-registry/);
  assert.match(runtimePinProblems({ ...base, scripts: { postinstall: "curl x | sh" } }, real).join(), /lifecycle script "postinstall"/);
  assert.match(runtimePinProblems({ ...base, version: "3.14.0-beta.20" }, real).join(), /not a stable/);
  // A backport plan allows its pins, not the rest of the SDK.
  const backport = loadPlan("courier-0.8.1");
  assert.match(runtimePinProblems(withDep("@tinycloud/cli", "1.9.0"), backport).join(), /not allowed by plan/);
});

test("layers put a package after everything it requires", () => {
  const manifests = nine.map((pkg) => stableManifest(pkg));
  const order = publishLayers(manifests).map((layer) => layer.map((pkg) => pkg.name));
  const position = (name) => order.findIndex((layer) => layer.includes(name));
  assert.ok(position("@tinycloud/bootstrap") < position("@tinycloud/sdk-services"));
  assert.ok(position("@tinycloud/node-sdk-wasm") < position("@tinycloud/node-sdk"));
  assert.ok(position("@tinycloud/replica") < position("@tinycloud/node-sdk"));
  assert.ok(position("@tinycloud/node-sdk") < position("@tinycloud/courier"));
  assert.ok(position("@tinycloud/courier") < position("@tinycloud/cli"));
  assert.ok(position("@tinycloud/operations") < position("@tinycloud/cli"));
});

// ---- release-commit provenance (real git) ------------------------------------------------------------------------

function gitFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "stage-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  for (const pkg of nine) write(`${pkg.dir}/package.json`, `${JSON.stringify(sourceManifest(pkg), null, 2)}\n`);
  write("packages/mcp/package.json", `${JSON.stringify({ name: "@tinycloud/mcp", version: "0.12.0-beta.19" }, null, 2)}\n`);
  write("bun.lock", "lock v1\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  const stabilizeAll = () => {
    for (const pkg of nine) write(`${pkg.dir}/package.json`, `${JSON.stringify(stableManifest(pkg), null, 2)}\n`);
  };
  const commit = () => {
    git(["add", "-A"]);
    git(["commit", "-qm", "release"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const repo = { isAncestor: (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: dir }).status === 0 };
  const verify = (head, plan = fixturePlan({ base })) => verifyReleaseCommit({ git, repo, plan, head });
  return { git, write, base, stabilizeAll, commit, verify, repo };
}

test("the exact version-only edit plus a settled bun.lock matches the sealed delta", (t) => {
  const f = gitFixture(t);
  f.stabilizeAll();
  f.write("bun.lock", "lock v2\n");
  assert.deepEqual(f.verify(f.commit()), []);
});

test("release-commit provenance refuses other paths, other packages and extra manifest edits", (t) => {
  const f = gitFixture(t);
  f.stabilizeAll();
  f.write("bun.lock", "lock v2\n");
  f.write("packages/mcp/package.json", `${JSON.stringify({ name: "@tinycloud/mcp", version: "0.12.0" }, null, 2)}\n`);
  f.write("packages/courier/src/index.ts", "export {};\n");
  f.write("packages/courier/package.json", `${JSON.stringify({ ...stableManifest(pkgOf("@tinycloud/courier")), description: "x" }, null, 2)}\n`);
  const problems = f.verify(f.commit()).join("\n");
  assert.match(problems, /delta .* is \[.*packages\/courier\/src\/index\.ts.*packages\/mcp\/package\.json/);
  assert.match(problems, /packages\/courier\/package\.json: not exactly the version-only edit/);
});

test("release-commit provenance refuses a stable bump left half done and a reformatted manifest", (t) => {
  const f = gitFixture(t);
  f.stabilizeAll();
  f.write("bun.lock", "lock v2\n");
  const core = pkgOf("@tinycloud/sdk-core");
  f.write(`${core.dir}/package.json`, `${JSON.stringify(sourceManifest(core), null, 2)}\n`);
  const bootstrap = pkgOf("@tinycloud/bootstrap");
  f.write(`${bootstrap.dir}/package.json`, JSON.stringify(stableManifest(bootstrap)));
  const problems = f.verify(f.commit()).join("\n");
  assert.match(problems, /packages\/sdk-core\/package\.json: not exactly the version-only edit/);
  assert.match(problems, /packages\/bootstrap\/package\.json: .*lines changed, expected 1/);
});

test("release-commit provenance refuses a release not directly on the source, and a source that is off the base", (t) => {
  const f = gitFixture(t);
  f.write("packages/mcp/package.json", `${JSON.stringify({ name: "@tinycloud/mcp", version: "0.12.0-beta.20" }, null, 2)}\n`);
  const middle = f.commit();
  f.stabilizeAll();
  f.write("bun.lock", "lock v2\n");
  const head = f.commit();
  // Sourced on the base, two commits up: the parent is not the source (and the delta carries the mcp edit).
  assert.match(f.verify(head).join("\n"), /parents are \[.*\], not exactly the source/);
  // Sourced on the reviewed middle commit: parent matches, but the plan must list the middle commit's path too.
  const onMiddle = fixturePlan({ base: f.base, sourceSha: middle });
  assert.match(f.verify(head, onMiddle).join("\n"), /delta .* the plan expects exactly/);
  const sealed = fixturePlan({ base: f.base, sourceSha: middle, expectedDelta: [...onMiddle.expectedDelta, "packages/mcp/package.json"] });
  assert.deepEqual(f.verify(head, sealed), []);
  // The source must descend from the base, and the release from the source.
  assert.match(f.verify(head, fixturePlan({ base: head, sourceSha: middle })).join("\n"), /is not an ancestor/);
  assert.match(f.verify(middle, fixturePlan({ base: f.base, sourceSha: head })).join("\n"), /is not an ancestor/);
});

test("release-commit provenance refuses a release that changes more than manifests and bun.lock on its source", (t) => {
  const f = gitFixture(t);
  f.stabilizeAll();
  f.write("bun.lock", "lock v2\n");
  f.write("packages/mcp/package.json", `${JSON.stringify({ name: "@tinycloud/mcp", version: "0.12.0" }, null, 2)}\n`);
  const head = f.commit();
  const plan = fixturePlan({ base: f.base, expectedDelta: [...policy.plans["courier-0.8.0"].expectedDelta, "packages/mcp/package.json"] });
  assert.match(f.verify(head, plan).join("\n"), /changes paths other than package manifests and bun\.lock: \[packages\/mcp\/package\.json\]/);
});

// ---- tarballs ------------------------------------------------------------------------------------------------------

const entry = (path, type = "-") => ({ path, type });
test("tarball checks refuse traversal, links, a wrong identity, a redirecting publishConfig and a missing build", () => {
  const pkg = pkgOf("@tinycloud/courier");
  const good = stableManifest(pkg);
  const files = [entry("package/package.json"), entry("package/dist/cli.js"), entry("package/dist/index.js")];
  assert.deepEqual(tarballProblems({ pkg, plan: real, entries: files, manifest: good }), []);
  const check = (entries, manifest) => tarballProblems({ pkg, plan: real, entries, manifest }).join();
  assert.match(check([...files, entry("package/../evil")], good), /unsafe path/);
  assert.match(check([...files, entry("/etc/passwd")], good), /unsafe path/);
  assert.match(check([...files, entry("package/link", "l")], good), /not a regular file/);
  assert.match(check(files, { ...good, version: "0.8.0-beta.19" }), /expected 0\.8\.0/);
  assert.match(check(files, { ...good, publishConfig: { registry: "https://evil.example" } }), /publishConfig\.registry/);
  assert.equal(check(files, { ...good, publishConfig: { access: "public", provenance: true } }), "");
  assert.match(check(files.slice(0, 2), good), /lacks dist\/index\.js/);
  const wasm = pkgOf("@tinycloud/node-sdk-wasm");
  assert.match(tarballProblems({ pkg: wasm, plan: real, entries: [entry("package/package.json"), entry("package/dist/index.js")], manifest: stableManifest(wasm) }).join(), /lacks dist\/wasm\/tinycloud_web_sdk_rs_bg\.wasm/);
});

// Real tarballs of the nine packages, then tampering with them.
function tarballFixture(t, { mutate } = {}) {
  const out = mkdtempSync(join(tmpdir(), "stage-tgz-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const records = [];
  for (const pkg of nine) {
    const stage = mkdtempSync(join(tmpdir(), "stage-src-"));
    const root = join(stage, "package");
    const write = (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const manifest = { ...stableManifest(pkg), exports: { ".": { import: "./dist/index.js" } }, main: "dist/index.js" };
    delete manifest.scripts;
    write("package.json", JSON.stringify(manifest, null, 2));
    for (const file of ["dist/index.js", "dist/cli.js", "bin/tinycloud", "dist/index.cjs", "dist/wasm/tinycloud_web_sdk_rs_bg.wasm", "dist/wasm/index.cjs"]) write(file, "x\n");
    mutate?.(pkg, write);
    const name = `${pkg.name.slice(1).replace("/", "-")}-${pkg.stable}.tgz`;
    assert.equal(spawnSync("tar", ["-czf", join(out, name), "-C", stage, "package"]).status, 0);
    rmSync(stage, { recursive: true, force: true });
    records.push({ name: pkg.name, version: pkg.stable, file: name });
  }
  return { out, records };
}

const finish = ({ out, records }, tweak = (m) => m) => {
  const packages = records.map((record) => {
    const data = readFileSync(join(out, record.file));
    return { ...record, sha256: createHash("sha256").update(data).digest("hex"), integrity: `sha512-${createHash("sha512").update(data).digest("base64")}` };
  });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(tweak({ plan: "fixture", release: RELEASE, tag: "staging", packages })));
  return out;
};
const plan = fixturePlan();

test("a faithful artifact of the nine tarballs verifies", (t) => {
  assert.deepEqual(verifyTarballs(plan, finish(tarballFixture(t))).problems, []);
});

test("an artifact is refused on a wrong plan, release, tag, digest, extra file or manifest digest", (t) => {
  const fx = tarballFixture(t);
  const problems = verifyTarballs(plan, finish(fx, (m) => ({ ...m, plan: "other", release: "f".repeat(40), tag: "latest" }))).problems.join("\n");
  assert.match(problems, /manifest plan other/);
  assert.match(problems, /manifest release f+ is not/);
  assert.match(problems, /manifest tag latest is not staging/);

  const good = finish(fx);
  writeFileSync(join(good, "tinycloud-extra-1.0.0.tgz"), "x");
  assert.match(verifyTarballs(plan, good).problems.join("\n"), /artifact files/);
  rmSync(join(good, "tinycloud-extra-1.0.0.tgz"));
  assert.match(verifyTarballs(plan, good, "0".repeat(64)).problems.join("\n"), /manifest\.json does not match/);
  writeFileSync(join(good, "tinycloud-courier-0.8.0.tgz"), "tampered");
  assert.match(verifyTarballs(plan, good).problems.join("\n"), /@tinycloud\/courier: /);
});

test("an artifact is refused when a package's exports point at a file it does not ship", (t) => {
  const dir = finish(tarballFixture(t, { mutate: (pkg, write) => { if (pkg.name === "@tinycloud/replica") write("dist/index.js", ""); } }));
  assert.match(verifyTarballs(plan, dir).problems.join("\n"), /@tinycloud\/replica: .*dist\/index\.js is missing or empty/);
});

// ---- publish orchestration (registry and npm replaced) -------------------------------------------------------------

function publishHarness(t, overrides = {}) {
  const dir = finish(tarballFixture(t));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const published = [];
  const log = [];
  const onNpm = new Map(Object.entries(plan.sharePair).map(([name, version]) => [`${name}@${version}`, "sha512-share"]));
  const io = {
    integrity: (name, version) => onNpm.get(`${name}@${version}`),
    runtimeDeps: () => ({}),
    distTags: () => ({ latest: "0.7.0", staging: "x" }),
    gitHead: () => RELEASE,
    head: () => RELEASE,
    publishPackage: ({ pkg, tag, integrity }) => {
      published.push({ name: pkg.name, tag, integrity });
      onNpm.set(`${pkg.name}@${pkg.stable}`, integrity);
      return 0;
    },
    waitServed: async () => ({ served: [], missing: [] }),
    ...overrides,
  };
  return { dir, manifest, published, log, io, run: () => publish(plan, dir, { io, log: (line) => log.push(line) }), onNpm };
}

test("publish sends the nine verified packages with the staging tag, dependencies first, once each", async (t) => {
  const h = publishHarness(t);
  await h.run();
  assert.equal(h.published.length, 9);
  assert.deepEqual([...new Set(h.published.map((p) => p.tag))], ["staging"]);
  for (const entry of h.manifest.packages) assert.equal(h.published.find((p) => p.name === entry.name).integrity, entry.integrity);
  const order = h.published.map((p) => p.name);
  assert.ok(order.indexOf("@tinycloud/bootstrap") < order.indexOf("@tinycloud/sdk-services"));
  assert.ok(order.indexOf("@tinycloud/courier") < order.indexOf("@tinycloud/cli"));
});

test("publish waits for each layer to be served before the next layer", async (t) => {
  const events = [];
  const h = publishHarness(t);
  h.io.publishPackage = ({ pkg }) => (events.push(`publish ${pkg.name}`), 0);
  h.io.waitServed = async (ids) => (events.push(`served ${ids.length}`), { served: ids, missing: [] });
  h.io.gitHead = () => RELEASE;
  await h.run();
  const firstServed = events.findIndex((e) => e.startsWith("served"));
  assert.ok(events.slice(0, firstServed).every((e) => e.startsWith("publish")));
  assert.ok(events.indexOf("publish @tinycloud/courier") < events.indexOf("publish @tinycloud/cli"));
  assert.ok(events.slice(events.indexOf("publish @tinycloud/node-sdk")).some((e) => e.startsWith("served")) );
});

test("publish skips versions npm already has with the same bytes and refuses different bytes", async (t) => {
  const same = publishHarness(t);
  const courier = same.manifest.packages.find((p) => p.name === "@tinycloud/courier");
  same.onNpm.set("@tinycloud/courier@0.8.0", courier.integrity);
  await same.run();
  assert.equal(same.published.some((p) => p.name === "@tinycloud/courier"), false);
  assert.equal(same.published.length, 8);

  const different = publishHarness(t);
  different.onNpm.set("@tinycloud/courier@0.8.0", "sha512-other");
  await assert.rejects(different.run(), /already on npm with different bytes/);
  assert.equal(different.published.length, 0, "nothing is published before every version is checked");
});

test("publish refuses before publishing anything when the artifact, the checkout or the share pair is wrong", async (t) => {
  const bad = publishHarness(t);
  writeFileSync(join(bad.dir, "tinycloud-cli-1.9.0.tgz"), "tampered");
  await assert.rejects(bad.run(), /refusing to publish/);
  assert.equal(bad.published.length, 0);

  const wrongHead = publishHarness(t, { head: () => "c".repeat(40) });
  await assert.rejects(wrongHead.run(), /is not the release commit/);
  assert.equal(wrongHead.published.length, 0);

  const noShare = publishHarness(t);
  noShare.onNpm.clear();
  await assert.rejects(noShare.run(), /@tinycloud\/share-sdk@1\.6\.0 is not on npm/);

  const nestedBeta = publishHarness(t, { runtimeDeps: () => ({ "@tinycloud/sdk-core": "3.14.0-beta.1" }) });
  await assert.rejects(nestedBeta.run(), /requires prerelease/);
  assert.equal(nestedBeta.published.length + noShare.published.length, 0);
});

test("publish stops at a failed package, a layer npm does not serve, a wrong gitHead and a moved latest tag", async (t) => {
  const failing = publishHarness(t);
  failing.io.publishPackage = ({ pkg }) => (failing.published.push({ name: pkg.name }), pkg.name === "@tinycloud/sdk-services" ? 1 : 0);
  await assert.rejects(failing.run(), /npm publish @tinycloud\/sdk-services@3\.14\.0 failed/);
  assert.equal(failing.published.some((p) => p.name === "@tinycloud/sdk-core"), false, "later layers are not published");

  const unserved = publishHarness(t, { waitServed: async (ids) => ({ served: [], missing: ids.map((id) => ({ id })) }) });
  await assert.rejects(unserved.run(), /npm does not serve/);
  assert.equal(unserved.published.length, 2, "only the first layer went out");

  await assert.rejects(publishHarness(t, { gitHead: () => undefined }).run(), /npm's gitHead is undefined/);

  let calls = 0;
  const moved = publishHarness(t, { distTags: () => ({ latest: calls++ < 9 ? "0.7.0" : "0.8.0" }) });
  await assert.rejects(moved.run(), /latest moved/);
});

// ---- npm config in the checkout (real git repo, the default readers) ---------------------------------------------------

// A checkout whose HEAD commits `committed` as the root .npmrc (or none), with `working` on disk afterwards.
function npmrcCheckout(t, { committed, working = committed, packageNpmrc } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stage-npmrc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args) => assert.equal(spawnSync("git", args, { cwd: dir }).status, 0, args.join(" "));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(dir, "packages/p"), { recursive: true });
  writeFileSync(join(dir, "packages/p/package.json"), "{}\n");
  if (committed !== undefined) writeFileSync(join(dir, ".npmrc"), committed);
  git(["add", "."]);
  git(["commit", "-qm", "x"]);
  if (working === undefined) rmSync(join(dir, ".npmrc"), { force: true });
  else writeFileSync(join(dir, ".npmrc"), working);
  if (packageNpmrc !== undefined) writeFileSync(join(dir, "packages/p/.npmrc"), packageNpmrc);
  return { cwd: dir, pkgDir: join(dir, "packages/p") };
}

test("the root .npmrc is accepted only as exactly the default registry line, with or without one trailing newline", (t) => {
  assert.equal(ROOT_NPMRC, "registry=https://registry.npmjs.org/");
  for (const text of [ROOT_NPMRC, `${ROOT_NPMRC}\n`]) {
    const { cwd, pkgDir } = npmrcCheckout(t, { committed: text });
    assert.deepEqual(npmrcProblems(cwd, pkgDir), [], JSON.stringify(text));
  }
  const none = npmrcCheckout(t, {});
  assert.deepEqual(npmrcProblems(none.cwd, none.pkgDir), [], "no root .npmrc at all");
});

test("any other root .npmrc is refused, even when it is the committed file", (t) => {
  const refused = [
    `${ROOT_NPMRC}\r\n`,
    `${ROOT_NPMRC}\n\n`,
    ` ${ROOT_NPMRC}\n`,
    `${ROOT_NPMRC} \n`,
    `${ROOT_NPMRC}\t`,
    "registry=https://registry.npmjs.org\n",
    "registry=https://evil.example/\n",
    `${ROOT_NPMRC}\n//registry.npmjs.org/:_authToken=abc\n`,
    `${ROOT_NPMRC}\nalways-auth=true\n`,
    "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
    "",
  ];
  for (const text of refused) {
    const { cwd, pkgDir } = npmrcCheckout(t, { committed: text });
    assert.match(npmrcProblems(cwd, pkgDir).join(), /is not exactly "registry=https:\/\/registry\.npmjs\.org\/"/, JSON.stringify(text));
  }
});

test("a root .npmrc that is not the release commit's file is refused, whatever it says", (t) => {
  // Written after checkout over a different (or no) committed file.
  for (const committed of [undefined, "registry=https://registry.npmjs.org/\n\n", "# other\n"]) {
    const { cwd, pkgDir } = npmrcCheckout(t, { committed, working: `${ROOT_NPMRC}\n` });
    assert.match(npmrcProblems(cwd, pkgDir).join(), /is not the release commit's committed file/, JSON.stringify(committed));
  }
  // Same bytes as committed but without the trailing newline the commit has: still not the committed file.
  const edited = npmrcCheckout(t, { committed: `${ROOT_NPMRC}\n`, working: ROOT_NPMRC });
  assert.match(npmrcProblems(edited.cwd, edited.pkgDir).join(), /is not the release commit's committed file/);
});

test("a package-directory .npmrc is always refused, even the benign line", (t) => {
  for (const packageNpmrc of [`${ROOT_NPMRC}\n`, "//registry.npmjs.org/:_authToken=abc\n", ""]) {
    const { cwd, pkgDir } = npmrcCheckout(t, { committed: `${ROOT_NPMRC}\n`, packageNpmrc });
    assert.match(npmrcProblems(cwd, pkgDir).join(), /packages\/p\/\.npmrc would change npm's registry or auth/, JSON.stringify(packageNpmrc));
  }
});

// ---- non-Courier plans: per-package requiredFiles and plan-dependent steps ------------------------------------------

const webSdkPlan = (requiredFiles) =>
  loadPlan("web", {
    ...policy,
    plans: {
      web: {
        ...policy.plans["courier-0.8.1"],
        packages: [{ name: "@tinycloud/web-sdk", dir: "packages/web-sdk", from: "3.14.0-beta.21", stable: "3.14.1", ...(requiredFiles ? { requiredFiles } : {}) }],
        pins: [],
      },
    },
  });
const WEB_FILES = ["dist/index.mjs", "dist/index.cjs", "dist/index.d.ts"];

test("a plan's requiredFiles replace the table for that package: a web-sdk build is accepted, a missing file refused", () => {
  const plan = webSdkPlan(WEB_FILES);
  const pkg = plan.packages[0];
  const manifest = { name: "@tinycloud/web-sdk", version: "3.14.1", dependencies: { zod: "^3.23.0" } };
  const shipped = ["package/package.json", ...WEB_FILES.map((file) => `package/${file}`)].map((path) => entry(path));
  assert.deepEqual(tarballProblems({ pkg, plan, entries: shipped, manifest }), []);
  const missing = tarballProblems({ pkg, plan, entries: shipped.filter((e) => e.path !== "package/dist/index.cjs"), manifest });
  assert.match(missing.join(), /@tinycloud\/web-sdk: tarball lacks dist\/index\.cjs/);
  // Without the plan's list the default (dist/index.js) applies and this build would be refused.
  const plain = webSdkPlan();
  assert.match(tarballProblems({ pkg: plain.packages[0], plan: plain, entries: shipped, manifest }).join(), /lacks dist\/index\.js/);
});

test("packages without requiredFiles keep the existing table and default", () => {
  assert.deepEqual(requiredFiles(pkgOf("@tinycloud/courier")), ["dist/cli.js", "dist/index.js"]);
  assert.deepEqual(requiredFiles(pkgOf("@tinycloud/cli")), ["bin/tinycloud", "dist/index.js"]);
  assert.deepEqual(requiredFiles(pkgOf("@tinycloud/bootstrap")), ["dist/index.js"]);
});

test("requiredFiles must be a non-empty list of safe relative paths", () => {
  for (const bad of [[], "dist/index.js", ["../evil"], ["/etc/passwd"], ["dist/../x"], ["dist//x"], ["./dist/x"], [""], [1], ["dist/a b"]]) {
    assert.throws(() => webSdkPlan(bad), /requiredFiles must be a non-empty list of safe relative paths/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => webSdkPlan(["dist/index.mjs", "dist/wasm/index.cjs"]));
});

test("the node release pin check applies only to plans that stage the CLI", () => {
  assert.deepEqual(planFlags(real), { nodeReleaseCheck: true });
  assert.deepEqual(planFlags(loadPlan("courier-0.8.1")), { nodeReleaseCheck: false });
  assert.deepEqual(planFlags(webSdkPlan(WEB_FILES)), { nodeReleaseCheck: false });
});

test("the tc-4082 plan is closed until sealed, and names the six packages with the files each must ship", () => {
  const plan = loadPlan("tc-4082");
  assert.match(sealProblems(plan).join("\n"), /releaseSha is null/);
  assert.match(sealProblems(plan).join("\n"), /expectedDelta/);
  assert.equal(plan.base, BASE);
  assert.equal(plan.sourceSha, "30025b74fccebc13c18f0b34ec0f87174b0304f7");
  assert.deepEqual(Object.fromEntries(plan.packages.map((pkg) => [pkg.name, pkg.stable])), {
    "@tinycloud/bootstrap": "2.10.1",
    "@tinycloud/sdk-services": "3.14.1",
    "@tinycloud/sdk-core": "3.14.1",
    "@tinycloud/node-sdk": "3.14.1",
    "@tinycloud/web-sdk-wasm": "1.8.0",
    "@tinycloud/web-sdk": "3.14.1",
  });
  assert.deepEqual(plan.pins.map((pin) => `${pin.name} ${pin.from}->${pin.to}`).sort(), ["@tinycloud/node-sdk-wasm 1.8.0-beta.0->1.8.0", "@tinycloud/replica 0.4.7-beta.6->0.4.7"]);
  // web-sdk is built, not excluded.
  assert.deepEqual(buildFilters(plan).filter((filter) => filter.startsWith("--filter=!")), []);
  assert.ok(buildFilters(plan).includes("--filter=@tinycloud/web-sdk..."));
  assert.ok(plan.packages.every((pkg) => requiredFiles(pkg).length >= 3), "every package states what it ships");
  assert.deepEqual(planFlags(plan), { nodeReleaseCheck: false });
});

test("tc-4082's web-sdk must ship every file its exports and entry chunks point at", () => {
  const webSdk = loadPlan("tc-4082").byName.get("@tinycloud/web-sdk");
  const files = new Set(requiredFiles(webSdk));
  // package.json main/module/types and the exports "." "./replica" "./replica-gated" "./credentials" targets.
  for (const file of ["index.cjs", "index.mjs", "index.d.ts", "replica.cjs", "replica.mjs", "replica.d.ts", "replica-gated.cjs", "replica-gated.mjs", "replica-gated.d.ts", "credentials.cjs", "credentials.mjs", "credentials-subpath.d.ts"]) {
    assert.ok(files.has(`dist/${file}`), file);
  }
  // Every entry chunk, in both module formats.
  for (const name of ["delegations-issued", "delegations-renewal", "encryption-keys", "modals", "panel-data", "panel", "registry-verdict-cache", "runtime-grants", "secret-read", "session-retire", "share-placement", "space-hosting"]) {
    for (const ext of ["cjs", "mjs"]) assert.ok(files.has(`dist/${name}.${ext}`), `${name}.${ext}`);
  }
  const staged = ["index.cjs", "index.mjs", "index.d.ts", ...[...files].map((f) => f.slice("dist/".length))].filter((f, i, all) => all.indexOf(f) === i);
  const shipped = staged.map((file) => entry(`package/dist/${file}`));
  const manifest = { name: "@tinycloud/web-sdk", version: "3.14.1", dependencies: { zod: "^3.23.0" } };
  const plan = loadPlan("tc-4082");
  assert.deepEqual(tarballProblems({ pkg: webSdk, plan, entries: [entry("package/package.json"), ...shipped], manifest }), []);
  assert.match(tarballProblems({ pkg: webSdk, plan, entries: [entry("package/package.json"), ...shipped.filter((e) => e.path !== "package/dist/space-hosting.mjs")], manifest }).join(), /lacks dist\/space-hosting\.mjs/);
});
