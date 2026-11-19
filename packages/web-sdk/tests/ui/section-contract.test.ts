import { describe, expect, test } from "bun:test";

import type { PanelDataSource, ViewResult } from "../../src/ui/data";
import { PANEL_SECTIONS } from "../../src/ui/sections";
import { ACCOUNT_STRINGS } from "../../src/ui/sections/account.strings";
import { ACTIVITY_STRINGS } from "../../src/ui/sections/activity.strings";
import { DELEGATIONS_STRINGS } from "../../src/ui/sections/delegations.strings";
import { LOCAL_COPY_STRINGS } from "../../src/ui/sections/local-copy.strings";
import { LOCAL_TINYCLOUD_STRINGS } from "../../src/ui/sections/local-tinycloud.strings";
import { NODES_STRINGS } from "../../src/ui/sections/nodes.strings";
import { STORAGE_PANEL_STRINGS } from "../../src/ui/sections/storage.strings";
import type { PanelSection, SectionContext, SectionId } from "../../src/ui/slots";
import { STRINGS, hasString } from "../../src/ui/strings";
import { panelText } from "../../src/ui/strings-panel";

const TABLES: Record<string, Readonly<Record<string, string>>> = {
  account: ACCOUNT_STRINGS,
  "local-tinycloud": LOCAL_TINYCLOUD_STRINGS,
  "local-copy": LOCAL_COPY_STRINGS,
  delegations: DELEGATIONS_STRINGS,
  nodes: NODES_STRINGS,
  storage: STORAGE_PANEL_STRINGS,
  activity: ACTIVITY_STRINGS,
};

const section = (id: SectionId): PanelSection => {
  const hit = PANEL_SECTIONS.find((entry) => entry.id === id);
  if (!hit) throw new Error(`no section ${id}`);
  return hit;
};

const ready = <T>(data: T): ViewResult<T> => ({ state: "ready", data }) as ViewResult<T>;
const loading = { state: "loading" } as ViewResult<never>;
const needsPermission = { state: "needs-permission", ability: "space/info" } as ViewResult<never>;
const failed = { state: "error", code: "unknown" } as ViewResult<never>;

interface CtxOptions {
  views?: Record<string, ViewResult<unknown>>;
  source?: boolean;
  requests?: { snapshot(): readonly unknown[] };
  signedIn?: boolean;
}

/** A context with only what `status(ctx)` may use: the cache, `text`, and the client. */
function ctxWith(options: CtxOptions = {}): SectionContext {
  const views = options.views ?? {};
  const source = options.source === false ? undefined : ({} as PanelDataSource);
  return {
    client: () => ({
      signedIn: () => options.signedIn ?? true,
      requests: options.requests,
    }),
    text: panelText,
    data: {
      source,
      latest: (key: string) => views[key],
      age: () => undefined,
      refresh: async () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as SectionContext;
}

describe("section entries", () => {
  test("each entry has an icon, a title the launcher table knows, and a status function", () => {
    for (const entry of PANEL_SECTIONS) {
      expect(typeof entry.icon).toBe("string");
      expect(hasString(entry.labelCode)).toBe(true);
      expect(typeof entry.status).toBe("function");
    }
  });

  test("every Overview summary resolves to copy, never the neutral line", () => {
    for (const entry of PANEL_SECTIONS) {
      if (entry.summaryCode === undefined) continue;
      expect(panelText(entry.summaryCode)).toBe(TABLES[entry.id][entry.summaryCode]);
    }
  });
});

describe("section strings", () => {
  test("each key starts with its section id", () => {
    for (const [id, table] of Object.entries(TABLES)) {
      for (const code of Object.keys(table)) expect(code.startsWith(`${id}.`)).toBe(true);
    }
  });

  test("no key is defined by two sections or shadows a launcher key", () => {
    const seen = new Map<string, string>();
    for (const [id, table] of Object.entries(TABLES)) {
      for (const code of Object.keys(table)) {
        expect(seen.has(code), `${code} is in ${seen.get(code)} and ${id}`).toBe(false);
        expect(code in STRINGS, `${code} shadows a strings.ts key`).toBe(false);
        seen.set(code, id);
      }
    }
  });

  test("registered section copy resolves through panelText, with params", () => {
    expect(panelText("nodes.glance.slow", { count: 2 })).toBe("2 slow");
    expect(panelText("activity.glance.errors", { count: 3 })).toBe("3 errors");
  });
});

describe("status(ctx): shared mapping", () => {
  test("loading, needs-permission and error stay neutral on every data-backed section", () => {
    for (const result of [loading, needsPermission, failed]) {
      const views = { localNode: result, localCopy: result, delegations: result, nodes: result, storage: result };
      for (const id of ["local-tinycloud", "local-copy", "delegations", "nodes", "storage"] as const) {
        expect(section(id).status(ctxWith({ views }))?.tone).toBe("info");
      }
    }
  });

  test("a missing data source reads as unavailable; an unread view shows nothing", () => {
    expect(section("nodes").status(ctxWith({ source: false }))).toEqual({ text: "Unavailable", tone: "info" });
    expect(section("nodes").status(ctxWith())).toBeUndefined();
  });
});

describe("status(ctx): each section", () => {
  test("Overview says nothing while signed in and 'Signed out' when not", () => {
    expect(section("account").status(ctxWith())).toBeUndefined();
    expect(section("account").status(ctxWith({ signedIn: false }))).toEqual({ text: "Signed out", tone: "off" });
  });

  test("local TinyCloud maps each connection state to its word and tone", () => {
    const cases = [
      ["found", "Found", "ok"],
      ["looking", "Looking", "info"],
      ["not-found", "Not found", "off"],
      ["off", "Off", "off"],
    ] as const;
    for (const [connection, text, tone] of cases) {
      const views = { localNode: ready({ connection }) };
      expect(section("local-tinycloud").status(ctxWith({ views }))).toEqual({ text, tone });
    }
  });

  test("local copy shows settled on or off, and transitional states stay neutral", () => {
    const status = (effective: string) =>
      section("local-copy").status(ctxWith({ views: { localCopy: ready({ effective }) } }));
    expect(status("on")).toEqual({ text: "On", tone: "ok" });
    expect(status("off")).toEqual({ text: "Off", tone: "off" });
    expect(status("enabling")?.tone).toBe("info");
  });

  test("delegations: Visible, with the page's row count and a plus when more pages exist", () => {
    const views = (page: object) => ({ delegations: ready(page) });
    expect(section("delegations").status(ctxWith({ views: views({ rows: [{}, {}, {}] }) }))).toEqual({
      text: "Visible",
      tone: "ok",
      count: "3",
    });
    expect(section("delegations").status(ctxWith({ views: views({ rows: [{}], nextCursor: "c" }) }))?.count).toBe("1+");
  });

  test("nodes: none is off, any down row warns, slow warns, all healthy is ok; the count is the row count", () => {
    const status = (rows: object[]) => section("nodes").status(ctxWith({ views: { nodes: ready(rows) } }));
    expect(status([])).toEqual({ text: "None", tone: "off", count: "0" });
    expect(status([{ status: "down" }, { status: "ok" }])).toEqual({ text: "1 down", tone: "warn", count: "2" });
    expect(status([{ status: "slow" }, { status: "ok" }, { status: "ok" }])).toEqual({
      text: "1 slow",
      tone: "warn",
      count: "3",
    });
    expect(status([{ status: "ok" }])).toEqual({ text: "Healthy", tone: "ok", count: "1" });
  });

  test("storage: full and nearly full warn, anything else is normal", () => {
    const status = (state: string) => section("storage").status(ctxWith({ views: { storage: ready({ state }) } }));
    expect(status("full")).toEqual({ text: "Full", tone: "warn" });
    expect(status("nearly_full")).toEqual({ text: "Nearly full", tone: "warn" });
    expect(status("normal")).toEqual({ text: "Normal", tone: "ok" });
  });

  test("activity: nothing without request logs; 'No errors' with a Clear rail value; failures counted", () => {
    expect(section("activity").status(ctxWith())).toBeUndefined();
    const log = (...ok: boolean[]) => ({ snapshot: () => ok.map((value, id) => ({ id, ok: value })) });
    const clean = section("activity").status(ctxWith({ requests: log(true) }));
    expect(clean).toEqual({ text: "No errors", tone: "ok", count: "Clear" });
    const failing = section("activity").status(ctxWith({ requests: log(true, false, false) }));
    expect(failing).toEqual({ text: "2 errors", tone: "warn" });
  });
});
