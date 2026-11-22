import assert from "node:assert/strict";
import test from "node:test";
import { checkContent, checkFileList, hexDigest, loadPublicHex } from "./audit-npm-tarballs.mjs";

// Token-shaped values are assembled at run time so the secret scan does not flag this file.
const hex64 = "3b".repeat(32);
const stripe = ["sk", "live", "Zq8".repeat(8)].join("_");
const awsKey = "AKIA" + "QX7Z".repeat(4);

test("file list: a clean package passes", () => {
  const files = ["package.json", "README.md", "LICENSE.md", "dist/index.js", "dist/index.d.ts", "dist/index.cjs.map", "bin/tc"];
  assert.deepEqual(checkFileList({ name: "@tinycloud/cli", files }), []);
});

test("file list: env files, keys, tests and fixtures fail", () => {
  const files = [".env.production", "dist/.npmrc", "dist/server.pem", "dist/index.test.js", "dist/fixtures/owner.json", "dist/test-vectors/a.json"];
  const problems = checkFileList({ name: "@tinycloud/cli", files });
  assert.equal(problems.length, files.length, problems.join("\n"));
});

test("file list: sourcemaps only in packages that ship them, unknown types fail", () => {
  assert.equal(checkFileList({ name: "@tinycloud/web-sdk", files: ["dist/index.js.map"] }).length, 1);
  assert.equal(checkFileList({ name: "@tinycloud/cli", files: ["dist/run.sh"] }).length, 1);
  assert.equal(checkFileList({ name: "@tinycloud/cli", files: ["dist/run"] }).length, 1);
  assert.equal(checkFileList({ name: "@tinycloud/cli", files: [] }).length, 1);
});

test("content: key and token shapes are found and the value is never printed", () => {
  const text = `const a = "${stripe}";\nconst b = "0x${hex64}";\nconst c = "${awsKey}";\n-----BEGIN EC PRIVATE KEY-----\n`;
  const problems = checkContent("pkg/dist/x.js", text, new Set());
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.ok(problems.some((problem) => /^pkg\/dist\/x\.js:2: 32-byte hex/.test(problem)), problems.join("\n"));
  for (const problem of problems) {
    assert.ok(!problem.includes(stripe) && !problem.includes(hex64) && !problem.includes(awsKey));
  }
});

test("content: reviewed public constants, base64 blobs and PEM codecs pass", () => {
  const publicHex = loadPublicHex(`${hexDigest(`0x${hex64.toUpperCase()}`)} # test constant\n`);
  const text = `p = BigInt("0x${hex64}");\nwasm = "AAAB${awsKey}CDEF";\nh = "-----BEGIN " + label + "-----";\n`;
  assert.deepEqual(checkContent("pkg/dist/x.js", text, publicHex), []);
});

test("public hex list: a malformed line fails loudly", () => {
  assert.throws(() => loadPublicHex("not-a-hash # oops\n"), /not a sha256/);
});
