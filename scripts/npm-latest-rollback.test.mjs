import test from "node:test";
import assert from "node:assert/strict";
import { parsePackages, requireConfirmation } from "./npm-latest-rollback.mjs";

test("rejects package entries outside the exact scoped semver shape", () => {
  for (const input of ["tinycloud/cli@1.0.0", "@tinycloud/cli@latest", "@tinycloud/cli@^1.0.0", "@tinycloud/cli@01.0.0"]) {
    assert.throws(() => parsePackages(input), /Invalid package spec/);
  }
});

test("rejects duplicate package entries, even with different versions", () => {
  assert.throws(() => parsePackages("@tinycloud/cli@1.0.0 @tinycloud/cli@1.0.1"), /Duplicate package/);
});

test("requires the exact rollback confirmation", () => {
  for (const confirm of [undefined, "", "release", "rollback "]) {
    assert.throws(() => requireConfirmation(confirm), /Type rollback/);
  }
});
