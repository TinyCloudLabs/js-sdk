import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { pinsFollow, pendingCount, readScope, scopedVersion, splitChangeset, verifyInventory } from "./scoped-version.mjs";

const changeset = (bumps, body = "Change.\n\nDetails: TC-1\n") =>
  `---\n${Object.entries(bumps).map(([name, bump]) => `"${name}": ${bump}`).join("\n")}\n---\n\n${body}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// An in-scope package `a` (stable), a held package `b` that requires it, and a held beta `c` that `a` may require.
function workspace(t, { scope = {}, a = {}, c = { version: "1.0.0-beta.2" } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "scoped-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  write(".github/release-scope.json", json({ enabled: true, packages: ["a"], expect: {}, ...scope }));
  write("packages/a/package.json", json({ name: "a", version: "2.0.0", ...a }));
  write("packages/a/CHANGELOG.md", "# a\n\n## 2.0.0\n");
  write("packages/b/package.json", json({ name: "b", version: "3.0.0-beta.4", dependencies: { a: "2.0.0" } }));
  write("packages/b/CHANGELOG.md", "# b\n\n## 3.0.0-beta.4\n");
  write("packages/c/package.json", json({ name: "c", ...c }));
  write(".changeset/mixed.md", changeset({ a: "patch", b: "minor" }));
  write(".changeset/held.md", changeset({ b: "patch" }));
  write(".changeset/own.md", changeset({ a: "patch" }));
  write(".changeset/README.md", "# Changesets\n");
  return { root, read: (path) => readFileSync(join(root, path), "utf8"), write };
}

// What `changeset version` does here: consume every changeset, bump a (and its dependent b), pin b to the new a.
const fakeChangesetVersion = (to = "2.0.1") => (root) => {
  for (const name of readdirSync(join(root, ".changeset"))) if (name.endsWith(".md") && name !== "README.md") rmSync(join(root, ".changeset", name));
  const a = JSON.parse(readFileSync(join(root, "packages/a/package.json"), "utf8"));
  writeFileSync(join(root, "packages/a/package.json"), json({ ...a, version: to }));
  writeFileSync(join(root, "packages/a/CHANGELOG.md"), `# a\n\n## ${to}\n\n## 2.0.0\n`);
  const b = JSON.parse(readFileSync(join(root, "packages/b/package.json"), "utf8"));
  writeFileSync(join(root, "packages/b/package.json"), json({ ...b, version: "3.0.0", dependencies: { a: to } }));
  writeFileSync(join(root, "packages/b/CHANGELOG.md"), `# b\n\n## 3.0.0\n\n## 3.0.0-beta.4\n`);
};

test("a changeset naming in-scope and held packages is split, and nothing is dropped", () => {
  const split = splitChangeset(changeset({ a: "patch", b: "minor" }), ["a"]);
  assert.equal(split.inScope, changeset({ a: "patch" }));
  assert.equal(split.held, changeset({ b: "minor" }));
  assert.equal(splitChangeset(changeset({ b: "minor" }), ["a"]).inScope, undefined);
  assert.equal(splitChangeset(changeset({ a: "minor" }), ["a"]).held, undefined);
});

test("only changesets that name an in-scope package count as pending", (t) => {
  const { root } = workspace(t);
  assert.equal(pendingCount(root, readScope(root)), 2);
});

test("versions in-scope packages only: held packages keep version, CHANGELOG and pending changesets, and follow the new pins", (t) => {
  const ws = workspace(t);
  const result = scopedVersion(ws.root, { runChangesetVersion: fakeChangesetVersion(), log: () => {} });
  assert.deepEqual(result.inventory, [{ name: "a", from: "2.0.0", to: "2.0.1", level: "patch" }]);
  assert.equal(result.putBack, 1);
  assert.equal(JSON.parse(ws.read("packages/a/package.json")).version, "2.0.1");
  const b = JSON.parse(ws.read("packages/b/package.json"));
  assert.equal(b.version, "3.0.0-beta.4");
  assert.equal(b.dependencies.a, "2.0.1");
  assert.equal(ws.read("packages/b/CHANGELOG.md"), "# b\n\n## 3.0.0-beta.4\n");
  assert.deepEqual(readdirSync(join(ws.root, ".changeset")).sort(), ["README.md", "held.md", "mixed.md"]);
  assert.equal(ws.read(".changeset/mixed.md"), changeset({ b: "minor" }));
  assert.equal(ws.read(".changeset/held.md"), changeset({ b: "patch" }));
});

test("refuses while the scope file is switched off", (t) => {
  const ws = workspace(t, { scope: { enabled: false } });
  assert.throws(() => scopedVersion(ws.root, { runChangesetVersion: fakeChangesetVersion(), log: () => {} }), /"enabled": false/);
  assert.equal(JSON.parse(ws.read("packages/a/package.json")).version, "2.0.0");
});

test("refuses a major bump, a prerelease and a result that differs from the locked inventory", () => {
  const inventory = [{ name: "a", from: "2.0.0", to: "3.0.0", level: "major" }];
  assert.match(verifyInventory({ inventory, expect: {}, outOfScopeChanges: [] })[0], /changes the major version/);
  assert.match(verifyInventory({ inventory: [{ name: "a", from: "2.0.0", to: "2.1.0-beta.1" }], expect: {}, outOfScopeChanges: [] })[0], /prerelease/);
  assert.match(verifyInventory({ inventory: [{ name: "a", from: "2.0.0", to: "2.0.1" }], expect: { a: "2.1.0" }, outOfScopeChanges: [] })[0], /expects a@2\.1\.0, this release gives 2\.0\.1/);
  assert.match(verifyInventory({ inventory: [{ name: "a", from: "2.0.0", to: "2.0.1" }], expect: { z: "1.0.0" }, outOfScopeChanges: [] }).join("\n"), /does not list a@2\.0\.1/);
  assert.deepEqual(verifyInventory({ inventory: [{ name: "a", from: "2.0.0", to: "2.0.1" }], expect: { a: "2.0.1" }, outOfScopeChanges: [] }), []);
});

test("refuses a stable package that requires a prerelease outside the scope", (t) => {
  const ws = workspace(t, { a: { dependencies: { c: "1.0.0-beta.2" } } });
  assert.throws(() => scopedVersion(ws.root, { runChangesetVersion: fakeChangesetVersion(), log: () => {} }), /a@2\.0\.1 requires c@1\.0\.0-beta\.2/);
});

test("pins follow only an exact old pin", () => {
  const raw = json({ name: "b", dependencies: { a: "2.0.0", z: "2.0.0" }, devDependencies: { a: "workspace:*" } });
  const moved = JSON.parse(pinsFollow(raw, new Map([["a", { from: "2.0.0", to: "2.0.1" }]])));
  assert.deepEqual(moved.dependencies, { a: "2.0.1", z: "2.0.0" });
  assert.equal(moved.devDependencies.a, "workspace:*");
  assert.equal(pinsFollow(raw, new Map()), raw);
});
