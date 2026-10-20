import { describe, expect, test } from "bun:test";

import {
  APPS_AGENT_EXPIRY,
  APPS_AGENT_MAX_APPS,
  appsAgentPermissions,
  appsAgentScopeNotice,
  describeGrantScope,
  matchAppsAgentRequest,
  resolveAppsAgentRequest,
} from "./apps-agent-preset.js";

const OWNER_SPACE = "tinycloud:pkh:eip155:1:0xAbC0000000000000000000000000000000000001:applications";
const HEALTH = "xyz.tinycloud.health";
const RECIPES = "xyz.tinycloud.recipes";

/** A request as the owner sees it after the agent's logical space is resolved to the owner's space. */
const asRequested = (mode: "read" | "write", appIds: string[] = []) =>
  appsAgentPermissions(mode, appIds).map((permission) => ({ ...permission, space: OWNER_SPACE }));

describe("apps-agent preset grants", () => {
  test("read-only (the default) is exactly KV get/list and SQL read on the applications space", () => {
    expect(appsAgentPermissions("read")).toEqual([
      { service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
      { service: "tinycloud.sql", space: "applications", path: "", actions: ["tinycloud.sql/read"] },
    ]);
    expect(APPS_AGENT_EXPIRY).toBe("7d");
  });

  test("write adds exactly KV put and SQL write, for named apps only", () => {
    expect(appsAgentPermissions("write", [HEALTH])).toEqual([
      { service: "tinycloud.kv", space: "applications", path: `${HEALTH}/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] },
      { service: "tinycloud.sql", space: "applications", path: `${HEALTH}/`, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
    ]);
  });

  test("each named app gets its own prefix for both services", () => {
    const permissions = appsAgentPermissions("read", [HEALTH, RECIPES]);
    expect(permissions.map(({ service, path }) => `${service} ${path}`)).toEqual([
      `tinycloud.kv ${HEALTH}/`,
      `tinycloud.kv ${RECIPES}/`,
      `tinycloud.sql ${HEALTH}/`,
      `tinycloud.sql ${RECIPES}/`,
    ]);
  });

  test("no variant carries delete, admin, schema, a wildcard or another service", () => {
    for (const mode of ["read", "write"] as const) {
      const permissions = appsAgentPermissions(mode, [HEALTH]);
      expect(new Set(permissions.map((permission) => permission.service))).toEqual(new Set(["tinycloud.kv", "tinycloud.sql"]));
      expect(permissions.flatMap((permission) => permission.actions).filter((action) => /\/(del|admin|ddl|schema|metadata)$|\*/.test(action))).toEqual([]);
    }
  });
});

describe("apps-agent scope notice states the facts of the grant", () => {
  test("read-only, all apps: names the space, says read-only and all apps, 7 days, no structure warning", () => {
    const notice = appsAgentScopeNotice("read");
    expect(notice).toContain("`applications` space");
    expect(notice).toContain("READ-ONLY");
    expect(notice).toContain("ALL your installed apps");
    expect(notice).toContain("7 days");
    expect(notice).toContain("delegation revoke <id>");
    expect(notice).not.toContain("(structure)");
  });

  test("read-only, one app: names that app and its prefix instead of all apps", () => {
    const notice = appsAgentScopeNotice("read", [HEALTH]);
    expect(notice).toContain(`\`${HEALTH}/\``);
    expect(notice).not.toContain("ALL your installed apps");
    expect(notice).toContain("READ-ONLY");
  });

  test("write names the apps, drops READ-ONLY and warns that tables can be changed or deleted", () => {
    const notice = appsAgentScopeNotice("write", [HEALTH, RECIPES]);
    expect(notice).toContain(`\`${HEALTH}/\``);
    expect(notice).toContain(`\`${RECIPES}/\``);
    expect(notice).not.toContain("READ-ONLY");
    expect(notice).not.toContain("ALL your installed apps");
    expect(notice).toContain("(structure)");
    expect(notice).toContain("cannot touch other apps, other spaces or secrets");
    expect(notice).toContain("7 days");
  });
});

describe("resolveAppsAgentRequest", () => {
  test("no preset, no change", () => {
    expect(resolveAppsAgentRequest({ cap: ["tinycloud.kv:applications::get"] })).toBeUndefined();
  });

  test("the default is read-only, for the whole space or for named apps", () => {
    expect(resolveAppsAgentRequest({ preset: "apps-agent" })).toEqual({ mode: "read", appIds: [] });
    expect(resolveAppsAgentRequest({ preset: "apps-agent", app: [HEALTH, RECIPES, HEALTH] })).toEqual({ mode: "read", appIds: [HEALTH, RECIPES] });
  });

  test("--write is an explicit opt-in that needs --app", () => {
    expect(resolveAppsAgentRequest({ preset: "apps-agent", write: true, app: [HEALTH] })).toEqual({ mode: "write", appIds: [HEALTH] });
    expect(() => resolveAppsAgentRequest({ preset: "apps-agent", write: true })).toThrow(
      expect.objectContaining({ exitCode: 2, message: expect.stringContaining("--write needs --app") }),
    );
  });

  test("at most five apps", () => {
    const apps = Array.from({ length: APPS_AGENT_MAX_APPS + 1 }, (_, index) => `app.n${index}`);
    expect(() => resolveAppsAgentRequest({ preset: "apps-agent", app: apps })).toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(resolveAppsAgentRequest({ preset: "apps-agent", app: apps.slice(0, APPS_AGENT_MAX_APPS) })?.appIds).toHaveLength(APPS_AGENT_MAX_APPS);
  });

  test("refuses anything that would make the printed scope untrue", () => {
    for (const options of [
      { app: [HEALTH] },
      { write: true },
      { preset: "other" },
      { preset: "apps-agent", cap: ["tinycloud.kv:account::get"] },
      { preset: "apps-agent", permission: "p.json" },
      { preset: "apps-agent", manifest: "m.json" },
      { preset: "apps-agent", expiry: "30d" },
      { preset: "apps-agent", device: true },
      { preset: "apps-agent", app: ["../account"] },
      { preset: "apps-agent", app: ["a/b"] },
    ]) {
      expect(() => resolveAppsAgentRequest(options)).toThrow(expect.objectContaining({ exitCode: 2 }));
    }
  });
});

describe("matchAppsAgentRequest (the owner side)", () => {
  test("recognises each variant, whole space or per app, in any order, with the preset lifetime", () => {
    expect(matchAppsAgentRequest(asRequested("read"), "7d", OWNER_SPACE)).toEqual({ mode: "read", appIds: [] });
    expect(matchAppsAgentRequest(asRequested("read").reverse(), "7d", OWNER_SPACE.toLowerCase())).toEqual({ mode: "read", appIds: [] });
    expect(matchAppsAgentRequest(asRequested("write", [HEALTH]), 7 * 86_400_000, OWNER_SPACE)).toEqual({ mode: "write", appIds: [HEALTH] });
    expect(matchAppsAgentRequest(asRequested("read", [HEALTH, RECIPES]), "7d", OWNER_SPACE)).toEqual({ mode: "read", appIds: [HEALTH, RECIPES] });
  });

  test("a different lifetime is not the preset", () => {
    for (const expiry of ["365d", "30d", "1d", "8d", undefined, "forever"]) {
      expect(matchAppsAgentRequest(asRequested("read"), expiry, OWNER_SPACE)).toBeUndefined();
    }
  });

  test("a different permission, path, action, caveat or per-entry lifetime is not the preset", () => {
    const [kv, sql] = asRequested("read");
    expect(matchAppsAgentRequest([{ ...kv!, actions: [...kv!.actions, "tinycloud.kv/del"] }, sql!], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, actions: [...sql!.actions, "tinycloud.sql/write"] }], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, path: "other/" }], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, expiry: "365d" }], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, caveats: [{}] }], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest([kv!], "7d", OWNER_SPACE)).toBeUndefined();
    expect(matchAppsAgentRequest(asRequested("write"), "7d", OWNER_SPACE)).toBeUndefined();
  });

  test("another owner's applications space, or a space that only ends in :applications, is not the owner's", () => {
    const foreign = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:applications";
    expect(matchAppsAgentRequest(asRequested("read"), "7d", foreign)).toBeUndefined();
    expect(matchAppsAgentRequest(asRequested("read").map((entry) => ({ ...entry, space: "evil:applications" })), "7d", OWNER_SPACE)).toBeUndefined();
  });
});

const DEFAULT_SPACE = "tinycloud:pkh:eip155:1:0xAbC0000000000000000000000000000000000001:default";
const scopeOf = (requested: Parameters<typeof describeGrantScope>[0], expiry: string | number | undefined = "7d") =>
  describeGrantScope(requested, expiry, OWNER_SPACE);
/** The "- " lines of the text: one per entry that will be signed. */
const entryLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

describe("describeGrantScope: the text follows what will be signed", () => {
  test("a request for 365 days never gets the 7-day preset wording", () => {
    const { text } = scopeOf(asRequested("read"), "365d");
    expect(text).toContain("365 days");
    expect(text).not.toContain("7 days");
    expect(text).toContain("not the standard apps-agent grant");
    expect(text).toContain("read files, list files");
  });

  test("the exact preset request prints only the preset wording, with 7 days and nothing to confirm", () => {
    for (const [requested, notice] of [
      [asRequested("read"), appsAgentScopeNotice("read")],
      [asRequested("write", [HEALTH]), appsAgentScopeNotice("write", [HEALTH])],
    ] as const) {
      const scope = scopeOf(requested);
      expect(scope.text).toBe(notice);
      expect(scope.extras).toEqual([]);
      expect(entryLines(scope.text)).toEqual([]);
    }
  });

  test("a shorter hand-made lifetime is printed as itself, not as the default", () => {
    const { text } = scopeOf(asRequested("read"), "2d");
    expect(text).toContain("2 days");
    expect(text).not.toContain("30 days");
  });

  test("a per-entry lifetime longer than the request's is the one that is printed", () => {
    const [kv, sql] = asRequested("read");
    expect(scopeOf([{ ...kv!, expiry: "90d" }, sql!]).text).toContain("90 days");
  });

  test("a request with no lifetime says it is the default", () => {
    const { text } = describeGrantScope(asRequested("read"), undefined, OWNER_SPACE);
    expect(text).toContain("30 days");
    expect(text).toContain("no lifetime was requested");
  });

  test("KV delete, whole-space SQL write and an unnamed write are beyond the preset and say what they do", () => {
    const scope = scopeOf([
      { service: "tinycloud.kv", space: OWNER_SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/del"] },
      { service: "tinycloud.sql", space: OWNER_SPACE, path: "", actions: ["tinycloud.sql/write"] },
      { service: "tinycloud.sql", space: OWNER_SPACE, path: `${HEALTH}/`, actions: ["tinycloud.sql/write"] },
    ]);
    expect(scope.text).toContain("MORE than the apps-agent preset");
    expect(scope.text).toContain("delete files");
    expect(scope.text).toContain("everything in the space");
    expect(scope.text).toContain("(structure)");
    expect(scope.text).toContain("TC-1581");
    // the named-app write is within what the preset can grant; the other two are not
    expect(scope.extras).toHaveLength(2);
  });

  test("a hand-made request inside the preset's limits (narrower paths, read, named-app write) needs no confirmation", () => {
    const scope = scopeOf([
      { service: "tinycloud.kv", space: OWNER_SPACE, path: `${HEALTH}/knowledge/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
      { service: "tinycloud.kv", space: OWNER_SPACE, path: `${HEALTH}/notes/`, actions: ["tinycloud.kv/put"] },
    ]);
    expect(scope.extras).toEqual([]);
    expect(scope.text).toContain("not the standard apps-agent grant");
    expect(entryLines(scope.text)).toHaveLength(2);
  });

  test("an extra delegation/create entry is listed, called out as passing access on, and needs confirmation", () => {
    const delegation = { service: "tinycloud.delegation", space: OWNER_SPACE, path: "", actions: ["tinycloud.delegation/create"] };
    const scope = scopeOf([...asRequested("read", [RECIPES]), delegation]);
    expect(scope.extras).toEqual([delegation]);
    expect(scope.text).toContain("This request asks for MORE than the apps-agent preset:");
    expect(scope.extraLines).toEqual([expect.stringContaining("pass access on to others")]);
    expect(scope.text).toContain("tinycloud.delegation");
    expect(scope.text).toContain("It can pass access on to others");
    expect(entryLines(scope.text)).toHaveLength(asRequested("read", [RECIPES]).length + 1);
  });

  test("an unknown service and an unknown action are printed raw and marked unrecognised", () => {
    const scope = scopeOf([
      ...asRequested("read"),
      { service: "tinycloud.zzz", space: OWNER_SPACE, path: "x", actions: ["tinycloud.zzz/frob", "tinycloud.zzz/*"] },
      { service: "tinycloud.kv", space: OWNER_SPACE, path: "", actions: ["tinycloud.kv/teleport"] },
    ]);
    expect(scope.text).toContain("unrecognised service tinycloud.zzz");
    expect(scope.text).toContain("unrecognised: grants tinycloud.zzz/frob");
    expect(scope.text).toContain("ALL abilities of tinycloud.zzz");
    expect(scope.text).toContain("unrecognised: grants tinycloud.kv/teleport");
    expect(scope.extras).toHaveLength(2);
  });

  test("an entry in a different space is listed with that space and needs confirmation", () => {
    const other = { service: "tinycloud.kv", space: DEFAULT_SPACE, path: "notes/", actions: ["tinycloud.kv/get"] };
    const scope = scopeOf([...asRequested("read"), other]);
    expect(scope.extras).toEqual([other]);
    expect(scope.text).toContain(`space \`${DEFAULT_SPACE}\``);
  });

  test("a request that touches no applications space is still described in full, with nothing to confirm", () => {
    const scope = scopeOf([{ service: "tinycloud.kv", space: DEFAULT_SPACE, path: "notes/", actions: ["tinycloud.kv/get"] }]);
    expect(scope.text).toContain("This request asks for:");
    expect(scope.text).toContain("notes/");
    expect(scope.extras).toEqual([]);
  });

  test("text from the request is escaped: no control, ANSI, newline or bidi character reaches the terminal", () => {
    const hostile = [
      { service: "tinycloud.kv\u001b[2J", space: `${OWNER_SPACE}\n`, path: "a\u001b[1A\u001b[2Kb/\raaaa\u202ex", actions: ["tinycloud.kv/\u001b[2Kx", "tinycloud.kv/get\u202e"] },
    ];
    const { text, extraLines } = scopeOf([...asRequested("read"), ...hostile]);
    for (const output of [text, ...extraLines]) {
      // eslint-disable-next-line no-control-regex
      expect(output.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
    expect(text).toContain("\\u{1b}[2J");
    expect(text).toContain("\\u{202e}");
    expect(text).toContain("\\u{d}");
  });

  test("the printed set equals the signed set: one line per entry, each naming that entry's service, path and actions", () => {
    const crafted = [
      asRequested("read"),
      [...asRequested("read", [HEALTH]), { service: "tinycloud.delegation", space: OWNER_SPACE, path: "", actions: ["tinycloud.delegation/create"] }],
      [...asRequested("write", [HEALTH, RECIPES]), { service: "tinycloud.hooks", space: OWNER_SPACE, path: "h/", actions: ["tinycloud.hooks/write"] }],
      [{ service: "tinycloud.kv", space: DEFAULT_SPACE, path: "a/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }, ...asRequested("read")],
      [
        { service: "tinycloud.sql", space: OWNER_SPACE, path: `${HEALTH}/`, actions: ["tinycloud.sql/read", "tinycloud.sql/admin"] },
        { service: "tinycloud.capabilities", space: OWNER_SPACE, path: "", actions: ["tinycloud.capabilities/read"] },
        { service: "tinycloud.duckdb", space: "evil:applications", path: "z", actions: ["tinycloud.duckdb/read"] },
      ],
    ];
    for (const requested of crafted) {
      const scope = scopeOf(requested, "9d");
      const lines = entryLines(scope.text);
      expect(lines).toHaveLength(requested.length);
      requested.forEach((entry, index) => {
        expect(lines[index]).toContain(entry.service);
        if (entry.path !== "") expect(lines[index]).toContain(entry.path);
        // every action is either in words or printed raw: none is dropped
        expect(lines[index]!.split(",").length).toBeGreaterThanOrEqual(entry.actions.length);
      });
      // an independent oracle: an entry is beyond the preset unless it is KV or SQL in the owner's
      // applications space with only read actions, or writes under a named app
      for (const entry of requested) {
        const inKvOrSql = entry.service === "tinycloud.kv" || entry.service === "tinycloud.sql";
        const named = /^[A-Za-z0-9][\w.-]*\//.test(entry.path);
        const allowed = (action: string) => /\/(get|list|read)$/.test(action) || (named && /\/(put|write)$/.test(action));
        const beyond = !(inKvOrSql && entry.space === OWNER_SPACE && entry.actions.every(allowed));
        expect(scope.extras.includes(entry)).toBe(beyond);
      }
    }
  });
});
