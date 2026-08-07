import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./check-beta-release-plan.mjs", import.meta.url);
const major = `---\n"@tinycloud/web-sdk": major\n---\n\nBreaking change.\n`;

async function fixture(preChangesets, extraChangesets = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tinycloud-beta-plan-"));
  await writeFile(join(directory, "pre.json"), JSON.stringify({ mode: "pre", tag: "beta", changesets: preChangesets }));
  await writeFile(join(directory, "reviewed-major.md"), major);
  for (const [name, source] of Object.entries(extraChangesets)) await writeFile(join(directory, name), source);
  return directory;
}

test("ignores major changesets already admitted to pre.json", async () => {
  const directory = await fixture(["reviewed-major"]);
  try {
    const result = spawnSync(process.execPath, [script.pathname, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /contains no major bumps/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("still rejects a newly introduced major changeset", async () => {
  const directory = await fixture(["reviewed-major"], { "new-major.md": major });
  try {
    const result = spawnSync(process.execPath, [script.pathname, directory], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Automatic beta release refuses unconfirmed major bumps/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
