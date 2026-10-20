import { describe, expect, test } from "bun:test";

import {
  APPS_AGENT_EXPIRY,
  APPS_AGENT_MAX_APPS,
  appsAgentPermissions,
  appsAgentScopeNotice,
  assertRequestFields,
  describeAction,
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
/** The entry lines of the text: `- ` for entries inside the preset's limits, `! ` for entries beyond them. */
const entryLines = (text: string) => text.split("\n").filter((line) => /^[-!] /.test(line));
const delegationEntry = (action: string) => ({ service: "tinycloud.delegation", space: OWNER_SPACE, path: "", actions: [action] });

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
      { service: "tinycloud.kv", space: OWNER_SPACE, path: "", actions: ["tinycloud.kv/del", "tinycloud.kv/get"] },
      { service: "tinycloud.sql", space: OWNER_SPACE, path: "", actions: ["tinycloud.sql/write"] },
      { service: "tinycloud.sql", space: OWNER_SPACE, path: `${HEALTH}/`, actions: ["tinycloud.sql/write"] },
    ]);
    expect(scope.text).toContain("MORE than the apps-agent preset");
    expect(scope.text).toContain("delete files");
    expect(scope.text).toContain("ALL apps in your `applications` space");
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

  test.each([
    ["tinycloud.delegation/create", "can give other people or agents access on your behalf"],
    ["tinycloud.delegation/revoke", "can cancel access you gave"],
    ["tinycloud.delegation/*", "can do everything the delegation permissions allow, including giving access on to others"],
  ])("%s gets its own plain-words line, in the entry list, with no 'unrecognised' wording", (action, words) => {
    const entry = delegationEntry(action);
    const scope = scopeOf([...asRequested("read", [RECIPES]), entry]);
    expect(scope.extras).toEqual([entry]);
    const lines = entryLines(scope.text).filter((line) => line.includes("tinycloud.delegation"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("! ");
    expect(lines[0]).toContain(words);
    expect(scope.text).not.toContain("unrecognised: grants tinycloud.delegation");
    expect(scope.text).not.toContain("ALL abilities of tinycloud.delegation");
  });

  test("each entry is printed once: an extra entry appears in one list only, not again in an 'in full' list or a footer", () => {
    const scope = scopeOf([...asRequested("read", [RECIPES]), delegationEntry("tinycloud.delegation/create")]);
    expect(scope.text.split("access on your behalf")).toHaveLength(2);
    expect(scope.text).not.toContain("In full");
    expect(entryLines(scope.text)).toHaveLength(scope.entries.length);
    // beyond-preset entries come first, marked
    expect(entryLines(scope.text)[0]).toStartWith("! ");
    expect(entryLines(scope.text).slice(1).every((line) => line.startsWith("- "))).toBe(true);
  });

  test("an unknown service and an unknown action are printed raw and marked unrecognised", () => {
    const scope = scopeOf([
      ...asRequested("read"),
      { service: "tinycloud.zzz", space: OWNER_SPACE, path: "x", actions: ["tinycloud.zzz/*", "tinycloud.zzz/frob"] },
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
    const { text } = scopeOf([...asRequested("read"), ...hostile]);
    // eslint-disable-next-line no-control-regex
    expect(text.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(text).toContain("\\u{1b}[2J");
    expect(text).toContain("\\u{202e}");
    expect(text).toContain("\\u{d}");
  });

  test("an ability named like an Object property is printed raw, not looked up", () => {
    const text = scopeOf([...asRequested("read"), { service: "tinycloud.kv", space: OWNER_SPACE, path: "", actions: ["constructor", "__proto__", "toString"] }]).text;
    expect(text).toContain("unrecognised: grants constructor");
    expect(text).toContain("unrecognised: grants toString");
    expect(text).not.toContain("native code");
  });
});

describe("describeAction wording", () => {
  test("every delegation ability and the kv/sql wildcards have plain words", () => {
    for (const action of ["tinycloud.delegation/create", "tinycloud.delegation/revoke", "tinycloud.delegation/*", "tinycloud.kv/*", "tinycloud.sql/*"]) {
      expect(describeAction(action)).not.toContain("unrecognised");
    }
  });
});

describe("flag values echoed in errors are escaped and clipped", () => {
  const HOSTILE = "\u001b[2J\u202e\u2028\u009b\u200b";
  // eslint-disable-next-line no-control-regex
  const RAW = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
  const message = (options: Parameters<typeof resolveAppsAgentRequest>[0]) => {
    try {
      resolveAppsAgentRequest(options);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a usage error");
  };

  test("--preset and --app values", () => {
    const preset = message({ preset: `bad${HOSTILE}` });
    expect(preset).not.toMatch(RAW);
    expect(preset).toContain("\\u{1b}[2J");
    const app = message({ preset: "apps-agent", app: [`bad${HOSTILE}`] });
    expect(app).not.toMatch(RAW);
    expect(app).toContain("\\u{202e}");
    expect(message({ preset: "apps-agent", app: ["x".repeat(5000)] }).length).toBeLessThan(400);
  });
});

describe("assertRequestFields: the fields that signer and parser errors quote", () => {
  const ok = { sessionDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" };

  test("accepts a DID with a fragment and a duration or number of milliseconds", () => {
    expect(() => assertRequestFields(ok)).not.toThrow();
    for (const requestedExpiry of [undefined, "7d", "12h", 3_600_000, "86400000"]) {
      expect(() => assertRequestFields({ ...ok, requestedExpiry })).not.toThrow();
    }
  });

  test.each([
    ["a hostile sessionDid", { sessionDid: `did:key:z6Mk${"\u001b[2J\u202e"}` }],
    ["a sessionDid with a newline", { sessionDid: "did:key:z6Mk\nx" }],
    ["a missing sessionDid", {}],
    ["a numeric sessionDid", { sessionDid: 7 }],
    ["an overlong sessionDid", { sessionDid: `did:key:${"z".repeat(400)}` }],
    ["a hostile requestedExpiry", { ...ok, requestedExpiry: "7d\u001b[2J\u202e" }],
    ["a requestedExpiry that is no duration", { ...ok, requestedExpiry: "soon" }],
    ["a negative requestedExpiry", { ...ok, requestedExpiry: -5 }],
    ["an object requestedExpiry", { ...ok, requestedExpiry: { a: 1 } }],
  ])("refuses %s with exit 2, fixed text and no echo", (_name, request) => {
    let thrown: unknown;
    try {
      assertRequestFields(request as Parameters<typeof assertRequestFields>[0]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ exitCode: 2 });
    expect((thrown as Error).message).toMatch(/^The request's (sessionDid|requestedExpiry) is not /);
    expect((thrown as Error).message).not.toMatch(/[\u0000-\u001f\u202e]/);
  });
});
