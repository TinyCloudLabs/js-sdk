import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-internal-dep-pins.mjs", import.meta.url));

// Writes one manifest per entry under packages/<dir> and runs the check on them.
function run(t, manifests) {
  const root = mkdtempSync(join(tmpdir(), "internal-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  manifests.forEach((manifest, index) => {
    mkdirSync(join(root, "packages", `p${index}`), { recursive: true });
    writeFileSync(join(root, "packages", `p${index}`, "package.json"), JSON.stringify(manifest));
  });
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

const core = { name: "@x/core", version: "2.0.1" };
const app = (deps, extra = {}) => ({ name: "@x/app", version: "1.0.0", dependencies: deps, ...extra });

test("exact pin to an older version fails", (t) => {
  const { status, output } = run(t, [core, app({ "@x/core": "2.0.0" })]);
  assert.equal(status, 1);
  assert.match(output, /@x\/app@1\.0\.0: dependencies "@x\/core": "2\.0\.0" does not include the current @x\/core@2\.0\.1/);
});

test("exact pin to the current version and a covering ^ range pass", (t) => {
  assert.equal(run(t, [core, app({ "@x/core": "2.0.1" })]).status, 0);
  assert.equal(run(t, [core, app({ "@x/core": "^2.0.0" })]).status, 0);
});

test("npm alias of the same package is checked by its version part", (t) => {
  assert.equal(run(t, [core, app({ "@x/core": "npm:@x/core@2.0.0" })]).status, 1);
  assert.equal(run(t, [core, app({ "@x/core": "npm:@x/core@^2.0.0" })]).status, 0);
});

test("unparseable specs fail closed", (t) => {
  for (const spec of ["garbage", "latest", "", "npm:@x/other@2.0.1", "npm:@x/core"]) {
    assert.equal(run(t, [core, app({ "@x/core": spec })]).status, 1, JSON.stringify(spec));
  }
});

test("stale peer and optional dependencies fail", (t) => {
  assert.equal(run(t, [core, app({}, { peerDependencies: { "@x/core": "^1.0.0" } })]).status, 1);
  assert.equal(run(t, [core, app({}, { optionalDependencies: { "@x/core": "1.0.0" } })]).status, 1);
});

test("private packages, non-registry specs and external packages are skipped", (t) => {
  assert.equal(run(t, [core, app({ "@x/core": "1.0.0" }, { private: true })]).status, 0);
  for (const spec of ["workspace:*", "catalog:", "file:../core", "link:../core", "https://example.com/core.tgz"]) {
    assert.equal(run(t, [core, app({ "@x/core": spec })]).status, 0, spec);
  }
  assert.equal(run(t, [core, app({ "left-pad": "garbage" })]).status, 0);
});
