import test from "node:test";
import assert from "node:assert/strict";
import { parsePackages, requireConfirmation, rollback } from "./npm-latest-rollback.mjs";

const validPackages = "@tinycloud/cli@1.0.0 @tinycloud/web-sdk@2.0.0 @tinycloud/node-sdk@3.0.0";

function captureRollback(input, confirm, runNpm) {
  const output = { log: [], error: [] };
  const log = console.log;
  const error = console.error;
  console.log = (...args) => output.log.push(args.join(" "));
  console.error = (...args) => output.error.push(args.join(" "));
  try {
    assert.throws(() => rollback(input, confirm, runNpm));
  } finally {
    console.log = log;
    console.error = error;
  }
  return output;
}

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

test("invalid or unconfirmed inputs make no npm mutation calls", () => {
  const cases = [
    ["", "rollback"],
    [" \n\t ", "rollback"],
    ["@other/cli@1.0.0", "rollback"],
    ["@tinycloud/cli@1.0.0; touch /tmp/pwned", "rollback"],
    ["@tinycloud/cli@1.0.0", undefined],
  ];
  for (const [input, confirm] of cases) {
    const calls = [];
    const output = captureRollback(input, confirm, (args) => { calls.push(args); return "1.0.0"; });
    assert.equal(calls.filter(([command]) => command === "dist-tag").length, 0, JSON.stringify(input));
    assert.match(output.error.join("\n"), /Completed moves: none/);
  }
});

test("a missing later npm version prevents every dist-tag mutation", () => {
  const calls = [];
  const output = captureRollback(validPackages, "rollback", (args) => {
    calls.push(args);
    return args[1] === "@tinycloud/node-sdk@3.0.0" ? "" : args[1].split("@").at(-1);
  });
  assert.deepEqual(calls.map(([command]) => command), ["view", "view", "view"]);
  assert.match(output.error.join("\n"), /Completed moves: none/);
});

test("a failed second add reports the first move and never adds the third", () => {
  const calls = [];
  const output = captureRollback(validPackages, "rollback", (args) => {
    calls.push(args);
    if (args[0] === "dist-tag" && args[2] === "@tinycloud/web-sdk@2.0.0") throw new Error("add failed");
    return args[0] === "view" ? args[1].split("@").at(-1) : "";
  });
  const adds = calls.filter(([command]) => command === "dist-tag").map(([, , spec]) => spec);
  assert.deepEqual(adds, ["@tinycloud/cli@1.0.0", "@tinycloud/web-sdk@2.0.0"]);
  assert.match(output.error.join("\n"), /Completed moves: @tinycloud\/cli@1\.0\.0/);
  assert.match(output.log.join("\n"), /Moved @tinycloud\/cli@1\.0\.0 to latest/);
  assert.match(output.log.join("\n"), /Dist-tags for @tinycloud\/cli:/);
});

test("a readback failure reports the version whose add succeeded", () => {
  const calls = [];
  const output = captureRollback("@tinycloud/cli@1.0.0", "rollback", (args) => {
    calls.push(args);
    if (args[0] === "view" && args[2] === "dist-tags") throw new Error("readback failed");
    return "1.0.0";
  });
  assert.deepEqual(calls.map(([command]) => command), ["view", "dist-tag", "view"]);
  assert.match(output.error.join("\n"), /Completed moves: @tinycloud\/cli@1\.0\.0/);
});
