import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "tc-grant-remove-"));
const previousHome = process.env.TC_HOME;
process.env.TC_HOME = home;
// State derives store paths at module evaluation, after the isolated test home is set.
const { additionalDelegationsPath, profileConfigPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { removeStoredDelegations } = await import("./permissions.js");
const profile = "grant-remove";
const path = additionalDelegationsPath(profile);
const cid = "bafkr4i" + "a".repeat(52);

async function seed(): Promise<void> {
  await writeJsonAtomic(profileConfigPath(profile), { name: profile });
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

test("removes all exact CID rows without changing survivors", async () => {
  await seed();
  const records = [
    { delegation: { cid }, canary: "first" },
    { delegation: { cid: "other" }, canary: { nested: true } },
    { delegation: { cid }, canary: "second" },
  ];
  await writeJsonAtomic(path, records);
  expect(await removeStoredDelegations(profile, cid)).toBe(2);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([records[1]]);
});

test("unknown CID leaves store contents and mtime untouched", async () => {
  await seed();
  await writeJsonAtomic(path, [{ delegation: { cid: "different" } }]);
  const before = await readFile(path);
  const mtime = (await stat(path)).mtimeMs;
  await expect(removeStoredDelegations(profile, cid)).rejects.toMatchObject({ code: "GRANT_NOT_FOUND", exitCode: 4 });
  expect(await readFile(path)).toEqual(before);
  expect((await stat(path)).mtimeMs).toBe(mtime);
});

test("a non-array store is not rewritten when no row matches", async () => {
  await seed();
  await writeJsonAtomic(path, { canary: "do-not-rewrite" });
  const before = await readFile(path);
  const mtime = (await stat(path)).mtimeMs;
  await expect(removeStoredDelegations(profile, cid)).rejects.toMatchObject({ code: "GRANT_NOT_FOUND" });
  expect(await readFile(path)).toEqual(before);
  expect((await stat(path)).mtimeMs).toBe(mtime);
});
