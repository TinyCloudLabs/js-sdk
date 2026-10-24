import { describe, expect, test } from "bun:test";
import { readGlanceStatus, UNAVAILABLE } from "../../src/ui/sections/glance-status";
import type { PanelDataSource, ViewResult } from "../../src/ui/data";
import { panelText } from "../../src/ui/strings-panel";

const ready = <T>(data: T): ViewResult<T> => ({ state: "ready", data }) as ViewResult<T>;
const loading = { state: "loading" } as ViewResult<never>;
const needsPermission = { state: "needs-permission", ability: "storage" } as unknown as ViewResult<never>;
const failed = { state: "error" } as ViewResult<never>;

function source(views: Partial<Record<"localNode" | "localCopy" | "delegations" | "nodes" | "storage", ViewResult<unknown>>>, requests?: () => unknown): PanelDataSource {
  const view = (key: keyof typeof views) => async () => views[key] ?? loading;
  return {
    localNode: view("localNode"),
    localCopy: view("localCopy"),
    delegations: view("delegations"),
    nodes: view("nodes"),
    storage: view("storage"),
    requests: requests as PanelDataSource["requests"],
  } as unknown as PanelDataSource;
}

describe("glance status", () => {
  test("loading, needs-permission and error stay neutral on every row", async () => {
    for (const result of [loading, needsPermission, failed]) {
      const data = source({ localNode: result, localCopy: result, nodes: result, storage: result, delegations: result });
      for (const id of ["local-tinycloud", "local-copy", "nodes", "storage", "delegations"] as const) {
        const status = await readGlanceStatus(data, id);
        expect(status?.tone).toBe("x");
      }
    }
  });

  test("a missing data source reads as unavailable", async () => {
    expect(await readGlanceStatus(undefined, "nodes")).toEqual(UNAVAILABLE);
  });

  test("local TinyCloud maps each connection state to its word and tone", async () => {
    const cases = [
      ["found", "glance.word.found", "on"],
      ["looking", "glance.word.looking", "x"],
      ["not-found", "glance.word.not_found", "off"],
      ["off", "glance.word.off", "off"],
    ] as const;
    for (const [connection, key, tone] of cases) {
      const status = await readGlanceStatus(source({ localNode: ready({ connection }) }), "local-tinycloud");
      expect(status).toEqual({ word: panelText(key), tone });
    }
  });

  test("local copy shows settled on or off, and transitional states stay neutral", async () => {
    const on = await readGlanceStatus(source({ localCopy: ready({ effective: "on" }) }), "local-copy");
    expect(on).toEqual({ word: panelText("glance.word.on"), tone: "on" });
    const off = await readGlanceStatus(source({ localCopy: ready({ effective: "off" }) }), "local-copy");
    expect(off).toEqual({ word: panelText("glance.word.off"), tone: "off" });
    const enabling = await readGlanceStatus(source({ localCopy: ready({ effective: "enabling" }) }), "local-copy");
    expect(enabling?.tone).toBe("x");
  });

  test("nodes: none is off, any down row is a warning, all healthy is on", async () => {
    const none = await readGlanceStatus(source({ nodes: ready([]) }), "nodes");
    expect(none).toEqual({ word: panelText("glance.word.none"), tone: "off" });
    const down = await readGlanceStatus(source({ nodes: ready([{ status: "down" }, { status: "ok" }]) }), "nodes");
    expect(down?.tone).toBe("warn");
    const healthy = await readGlanceStatus(source({ nodes: ready([{ status: "ok" }]) }), "nodes");
    expect(healthy).toEqual({ word: panelText("glance.word.healthy"), tone: "on" });
  });

  test("storage: full and nearly full are warnings, normal is on", async () => {
    const full = await readGlanceStatus(source({ storage: ready({ state: "full" }) }), "storage");
    expect(full).toEqual({ word: panelText("glance.word.full"), tone: "warn" });
    const nearly = await readGlanceStatus(source({ storage: ready({ state: "nearly_full" }) }), "storage");
    expect(nearly).toEqual({ word: panelText("glance.word.nearly_full"), tone: "warn" });
    const normal = await readGlanceStatus(source({ storage: ready({ state: "normal" }) }), "storage");
    expect(normal).toEqual({ word: panelText("glance.word.normal"), tone: "on" });
  });

  test("activity has no status without request logs, and counts failed requests otherwise", async () => {
    expect(await readGlanceStatus(source({}), "activity")).toBeUndefined();
    const clean = await readGlanceStatus(source({}, () => ({ rows: () => [{ ok: true }] })), "activity");
    expect(clean).toEqual({ word: panelText("glance.word.no_errors"), tone: "on" });
    const failing = await readGlanceStatus(source({}, () => ({ rows: () => [{ ok: true }, { ok: false }] })), "activity");
    expect(failing?.tone).toBe("warn");
  });
});
