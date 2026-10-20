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

describe("describeGrantScope: the text follows what will be signed", () => {
  test("a request for 365 days never gets the 7-day preset wording", () => {
    const scope = describeGrantScope(asRequested("read"), "365d", OWNER_SPACE)!;
    expect(scope).toContain("365 days");
    expect(scope).not.toContain("7 days");
    expect(scope).toContain("not the standard apps-agent grant");
    expect(scope).toContain("read files, list files");
  });

  test("the exact preset request prints the preset wording with 7 days", () => {
    expect(describeGrantScope(asRequested("read"), "7d", OWNER_SPACE)).toBe(appsAgentScopeNotice("read"));
    expect(describeGrantScope(asRequested("write", [HEALTH]), "7d", OWNER_SPACE)).toBe(appsAgentScopeNotice("write", [HEALTH]));
  });

  test("a shorter hand-made lifetime is printed as itself, not as the default", () => {
    const scope = describeGrantScope(asRequested("read"), "2d", OWNER_SPACE)!;
    expect(scope).toContain("2 days");
    expect(scope).not.toContain("30 days");
  });

  test("a per-entry lifetime longer than the request's is the one that is printed", () => {
    const [kv, sql] = asRequested("read");
    expect(describeGrantScope([{ ...kv!, expiry: "90d" }, sql!], "7d", OWNER_SPACE)).toContain("90 days");
  });

  test("a request with no lifetime says it is the default", () => {
    const scope = describeGrantScope(asRequested("read"), undefined, OWNER_SPACE)!;
    expect(scope).toContain("30 days");
    expect(scope).toContain("no lifetime was requested");
  });

  test("KV delete and SQL write in a hand-made request are described, with the structure warning for SQL write", () => {
    const scope = describeGrantScope([
      { service: "tinycloud.kv", space: OWNER_SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/del"] },
      { service: "tinycloud.sql", space: OWNER_SPACE, path: `${HEALTH}/`, actions: ["tinycloud.sql/write"] },
    ], "7d", OWNER_SPACE)!;
    expect(scope).toContain("delete files");
    expect(scope).toContain("everything in the space");
    expect(scope).toContain(`\`${HEALTH}/\``);
    expect(scope).toContain("(structure)");
  });

  test("a request that does not touch an applications space prints nothing", () => {
    expect(describeGrantScope([
      { service: "tinycloud.kv", space: "tinycloud:pkh:eip155:1:0x1:default", path: "notes/", actions: ["tinycloud.kv/get"] },
    ], "7d", OWNER_SPACE)).toBeUndefined();
  });
});
