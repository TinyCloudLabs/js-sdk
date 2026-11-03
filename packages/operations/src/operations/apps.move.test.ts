import { describe, expect, test } from "bun:test";
import { tcAppsApprovalReason } from "../tc-apps.js";
import { moveApp } from "../tc-apps/move.js";
import type { RuntimeOperationContext } from "../contract.js";
import { definition, fixture, itemKind, LEGACY_ROOT_GRANT, NEW_SPACE, SPACE, withGrants, type FakeKv } from "./apps.fixtures.js";

const ID = "xyz.tinycloud.tinyapps.fitness/";
const LEGACY = "xyz.tinycloud.agent-data/";
const ENTRY = "xyz.tinycloud.tinyapps.catalog/fitness/entry";
const DISCOVERY_GRANT = { service: "tinycloud.kv", space: NEW_SPACE, path: "xyz.tinycloud.tinyapps.catalog/", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] };
const APP_GRANT = { service: "tinycloud.kv", space: NEW_SPACE, path: ID, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] };
const LEGACY_READ = { service: "tinycloud.kv", space: SPACE, path: LEGACY, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const oldKey = (n: number) => `${LEGACY}fitness/weight/2026-10/${day(n)}`;
const newKey = (n: number) => `${ID}weight/2026-10/${day(n)}`;

function seedOld(kv: FakeKv, count: number) {
  for (let n = 1; n <= count; n++) kv.seed(oldKey(n), { v: 1, at: day(n), data: { kg: 70 + n }, by: "claude-code" });
}
function stored(kv: FakeKv, key: string) { return JSON.parse(kv.values.get(key)!.text) as Record<string, unknown>; }
function move(context: RuntimeOperationContext, dryRun: boolean) {
  return definition("move").execute(withGrants(context, [LEGACY_READ, APP_GRANT, DISCOVERY_GRANT]), { app: "fitness", dryRun });
}
const untouched = (kv: FakeKv) => { expect(kv.writes).toEqual([]); expect(kv.deletes).toEqual([]); };

describe("moving an app to the new layout", () => {
  test("a dry run reports the plan and writes nothing, asking only for read access to the older layout", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 3);
      kv.seed(`${LEGACY}catalog/fitness/goal`, itemKind);
      const dry = { app: "fitness", dryRun: true } as never;
      expect(await definition("move").authority(context, dry)).toEqual([LEGACY_READ]);
      const result = await move(context, true);
      expect(result.output).toMatchObject({ app: "fitness", status: "dry_run", total: 6, catalog: 3, kinds: [{ kind: "weight", count: 3 }] });
      untouched(kv);
      expect(applications.writes).toEqual([]);
      expect(tcAppsApprovalReason([LEGACY_READ])).toContain("Nothing in your default space is changed or deleted");
      expect(tcAppsApprovalReason([LEGACY_READ])).not.toContain("delete them");
    });
  });
  test("a real run asks for one space at a time", async () => {
    await fixture(async (_kv, context) => {
      const run = { app: "fitness", dryRun: false } as never;
      expect(await definition("move").authority(context, run)).toEqual([LEGACY_READ]);
      expect(await definition("move").authority(withGrants(context, [LEGACY_ROOT_GRANT]), run)).toEqual([APP_GRANT, DISCOVERY_GRANT]);
      expect(await definition("move").authority(withGrants(context, [LEGACY_READ, APP_GRANT, DISCOVERY_GRANT]), run)).toEqual([LEGACY_READ, APP_GRANT, DISCOVERY_GRANT]);
    });
  });
  test("copies the catalog first and the discovery entry last, byte-equal, and never writes or deletes in the older layout", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 3);
      const result = await move(context, false);
      expect(result.output).toMatchObject({ status: "moved", total: 5, catalog: 2 });
      const puts = applications.writes.map((write) => write.key);
      expect(puts).toEqual([`${ID}catalog`, `${ID}catalog/weight`, newKey(1), newKey(2), newKey(3), `${ID}index-stale/weight`, ENTRY]);
      expect(applications.writes.filter((write) => !write.key.includes("index-stale")).every((write) => write.options.ifNoneMatch === "*")).toBe(true);
      expect(stored(applications, newKey(2))).toEqual(stored(kv, oldKey(2)));
      expect(stored(applications, ENTRY)).toEqual({ v: 1, app: "fitness", id: "xyz.tinycloud.tinyapps.fitness", title: "Fitness" });
      untouched(kv);
      expect([...kv.values.keys()].filter((key) => key.startsWith(`${LEGACY}fitness/`))).toHaveLength(3);
    });
  });
  test("the app is then listed once, as new, and an older-root write is refused", async () => {
    await fixture(async (kv, context) => {
      seedOld(kv, 1);
      await move(context, false);
      const listed = await definition("context").execute(withGrants(context, [LEGACY_ROOT_GRANT, DISCOVERY_GRANT]), {});
      expect(listed.output.apps).toEqual([{ app: "fitness", layout: "new", title: "Fitness", copy: "none" }]);
      const refused = await definition("write").execute(withGrants(context, [LEGACY_ROOT_GRANT, DISCOVERY_GRANT]), { ops: [{ op: "put", key: oldKey(9), value: { data: { kg: 1 } } }] });
      expect(refused.output.ops[0]?.outcome).toBe("INVALID");
    });
  });
  test("running it again after it moved changes nothing", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 2);
      await move(context, false);
      const writes = applications.writes.length;
      const again = await move(context, false);
      expect(again.output).toMatchObject({ status: "already_moved" });
      expect(applications.writes.length).toBe(writes);
      untouched(kv);
    });
  });
  test("an interrupted copy resumes: keys already holding the same content are recognised, not rewritten", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 4);
      applications.seed(`${ID}catalog`, { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14", by: "tinycloud-mcp" });
      kv.seed(`${LEGACY}catalog/fitness`, { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14", by: "tinycloud-mcp" });
      applications.seed(newKey(1), { by: "claude-code", data: { kg: 71 }, at: day(1), v: 1 });
      const result = await move(context, false);
      expect(result.output).toMatchObject({ status: "moved" });
      expect(applications.writes.map((write) => write.key)).not.toContain(newKey(1));
      expect(applications.writes.map((write) => write.key)).not.toContain(`${ID}catalog`);
      expect(applications.writes.map((write) => write.key)).toContain(newKey(4));
    });
  });
  test("a different record already at the destination is a conflict: nothing is overwritten and the app does not switch", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 3);
      const theirs = applications.seed(newKey(2), { v: 1, at: day(2), data: { kg: 1 }, by: "codex" });
      const result = await move(context, false);
      expect(result.output.status).toBe("CONFLICT");
      expect(result.output.conflicts).toEqual([{ from: oldKey(2), to: newKey(2), fromEtag: expect.any(String), toEtag: theirs }]);
      expect(stored(applications, newKey(2)).data).toEqual({ kg: 1 });
      expect(applications.values.has(ENTRY)).toBe(false);
      untouched(kv);
    });
  });
  test("keys already in the new folder that the old app does not have stop the move before anything is written", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 2);
      applications.seed(newKey(30), { v: 1, at: day(30), data: { kg: 80 } });
      const result = await move(context, false);
      expect(result.output.status).toBe("NOT_SWITCHED");
      expect(result.output.problems?.join(" ")).toContain(newKey(30));
      expect(applications.writes).toEqual([]);
    });
  });
  test("an edit in the older place while copying means no switch", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 3);
      applications.beforePut = (key) => { if (key === newKey(3)) kv.seed(oldKey(1), { v: 1, at: day(1), data: { kg: 1 } }); };
      const edited = await move(context, false);
      expect(edited.output.status).toBe("NOT_SWITCHED");
      expect(edited.output.problems).toEqual([`${newKey(1)}: reads back different from the older record`]);
      expect(applications.values.has(ENTRY)).toBe(false);
    });
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 3);
      applications.beforePut = (key) => { if (key === newKey(3)) kv.seed(oldKey(9), { v: 1, at: day(9), data: { kg: 9 } }); };
      const added = await move(context, false);
      expect(added.output.status).toBe("NOT_SWITCHED");
      expect(applications.values.has(ENTRY)).toBe(false);
    });
  });
  test("a long copy stops at its time budget, reports what remains, and the next call finishes without rewriting", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 250);
      let now = 0;
      const env = { legacy: kv, next: applications, clock: () => now, budgetMs: 60_000 };
      const base = { app: "fitness", dryRun: false };
      const first = await moveApp({ ...env, clock: () => { const at = now; now += 40_000; return at; } }, base.app, false);
      expect(first).toMatchObject({ status: "MOVE_PARTIAL" });
      expect((first.copied ?? 0) + (first.remaining ?? 0)).toBe(252);
      expect(applications.values.has(ENTRY)).toBe(false);
      const copied = applications.writes.length;
      const second = await moveApp({ ...env, clock: () => 0 }, base.app, false);
      expect(second.status).toBe("moved");
      const written = applications.writes.map((write) => write.key);
      expect(new Set(written).size).toBe(written.length);
      expect(written.length).toBeGreaterThan(copied);
      expect(written.at(-1)).toBe(ENTRY);
      untouched(kv);
    });
  });
  test("reserved names and kinds the new layout reserves stay where they are", async () => {
    await fixture(async (kv, context) => {
      const reserved = await definition("move").execute(withGrants(context, [LEGACY_READ, APP_GRANT, DISCOVERY_GRANT]), { app: "healthlog", dryRun: false });
      expect(reserved.output.status).toBe("NOT_SWITCHED");
      kv.seed(`${LEGACY}fitness/catalog/2026-10/x`, { v: 1, data: {} });
      const clash = await move(context, true);
      expect(clash.output.status).toBe("NOT_SWITCHED");
      expect(clash.output.problems?.join(" ")).toContain(`${LEGACY}fitness/catalog/2026-10/x`);
    });
  });
  test("an app with no older records has nothing to move", async () => {
    await fixture(async (kv, context, applications) => {
      for (const key of [...kv.values.keys()]) kv.values.delete(key);
      const result = await move(context, false);
      expect(result.output.status).toBe("nothing_to_move");
      expect(applications.writes).toEqual([]);
    });
  });
  test("a moved app keeps its kind catalog shape: kinds and counts match what was there", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 2);
      kv.seed(`${LEGACY}catalog/fitness/goal`, itemKind);
      kv.seed(`${LEGACY}fitness/goal/open/2026-10-14-goal`, { v: 1, at: day(14), data: { title: "goal" } });
      const result = await move(context, false);
      expect(result.output).toMatchObject({ status: "moved", total: 6, catalog: 3 });
      expect(result.output.kinds).toEqual([{ kind: "goal", count: 1 }, { kind: "weight", count: 2 }]);
      expect(stored(applications, `${ID}catalog/goal`)).toEqual(stored(kv, `${LEGACY}catalog/fitness/goal`));
    });
  });
});

describe("moving an app: guards found in the security review", () => {
  test("a rerun makes progress however much is already copied: the budget covers copying only, so a large app finishes", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 250);
      // 130 records and the catalog already sit in the new folder from earlier runs.
      applications.seed(`${ID}catalog`, stored(kv, `${LEGACY}catalog/fitness`));
      applications.seed(`${ID}catalog/weight`, stored(kv, `${LEGACY}catalog/fitness/weight`));
      for (let n = 1; n <= 130; n++) applications.seed(newKey(n), stored(kv, oldKey(n)));
      let now = 0;
      const env = { legacy: kv, next: applications, clock: () => (now += 100_000), budgetMs: 60_000 };
      const first = await moveApp(env, "fitness", false);
      expect(first).toMatchObject({ status: "MOVE_PARTIAL", copied: 100, remaining: 20 });
      expect(applications.values.has(ENTRY)).toBe(false);
      const second = await moveApp(env, "fitness", false);
      expect(second.status).toBe("moved");
      expect(applications.writes.filter((write) => write.key === newKey(5))).toEqual([]);
      untouched(kv);
    });
  });
  test("an app above the ceiling is refused before anything is copied, even for a dry run", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 5001);
      for (const dryRun of [true, false]) {
        const result = await move(context, dryRun);
        expect(result.output.status).toBe("NOT_SWITCHED");
        expect(result.output.message).toContain("at most");
      }
      expect(applications.writes).toEqual([]);
    });
  });
  test("records without an older catalog record are not an older app: nothing is moved or switched", async () => {
    await fixture(async (kv, context, applications) => {
      kv.values.delete(`${LEGACY}catalog/fitness`);
      kv.values.delete(`${LEGACY}catalog/fitness/weight`);
      seedOld(kv, 2);
      expect((await move(context, false)).output.status).toBe("nothing_to_move");
      expect(applications.writes).toEqual([]);
    });
  });
  test("every moved kind is marked stale before the switch, so an earlier fast copy is rebuilt", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 1);
      kv.seed(`${LEGACY}catalog/fitness/goal`, itemKind);
      kv.seed(`${LEGACY}fitness/goal/open/2026-10-14-goal`, { v: 1, at: day(14), data: { title: "goal" } });
      await move(context, false);
      const keys = applications.writes.map((write) => write.key);
      for (const kindName of ["goal", "weight"]) expect(keys.indexOf(`${ID}index-stale/${kindName}`)).toBeLessThan(keys.indexOf(ENTRY));
    });
  });
  test("records written to the older place after the move are reported, not stranded silently", async () => {
    await fixture(async (kv, context, applications) => {
      seedOld(kv, 2);
      applications.beforePut = (key) => { if (key === ENTRY) kv.seed(oldKey(9), { v: 1, at: day(9), data: { kg: 9 } }); };
      const result = await move(context, false);
      expect(result.output).toMatchObject({ status: "moved", drift: [oldKey(9)] });
      applications.beforePut = undefined;
      const again = await move(context, false);
      expect(again.output).toMatchObject({ status: "already_moved", drift: [oldKey(9)] });
      untouched(kv);
    });
  });
});
