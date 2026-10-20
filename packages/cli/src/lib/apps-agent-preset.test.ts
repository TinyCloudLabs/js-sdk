import { describe, expect, test } from "bun:test";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

import {
  APPS_AGENT_EXPIRY,
  appsAgentPermissions,
  appsAgentScopeNotice,
  matchAppsAgentRequest,
  resolveAppsAgentRequest,
} from "./apps-agent-preset.js";

describe("apps-agent preset grant", () => {
  test("is exactly KV get/list/put and SQL read/write on the applications space for 7 days", () => {
    expect(appsAgentPermissions()).toEqual([
      { service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] },
      { service: "tinycloud.sql", space: "applications", path: "", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
    ]);
    expect(APPS_AGENT_EXPIRY).toBe("7d");
  });

  test("--app narrows both services to that app's prefix and changes nothing else", () => {
    const narrowed = appsAgentPermissions("xyz.tinycloud.health");
    expect(narrowed.map(({ path }) => path)).toEqual(["xyz.tinycloud.health/", "xyz.tinycloud.health/"]);
    expect(narrowed.map(({ path: _path, ...rest }) => rest)).toEqual(
      appsAgentPermissions().map(({ path: _path, ...rest }) => rest),
    );
  });

  test("carries no delete, schema-admin or wildcard action", () => {
    const actions = appsAgentPermissions().flatMap((permission) => permission.actions);
    expect(actions.filter((action) => /\/(del|admin|ddl|schema)$|\*/.test(action))).toEqual([]);
  });
});

describe("apps-agent scope notice", () => {
  test("states the whole-space grant in plain words", () => {
    expect(appsAgentScopeNotice()).toBe([
      "This gives the agent access to ALL your installed apps' data in the `applications` space.",
      "It can: read files, list files, create and overwrite files, read table rows, add, change and delete table rows.",
      "It cannot delete files, change a table's structure, or touch any other space.",
      `It lasts 7 days, and you can revoke it any time with \`${CLI_NAME} delegation revoke <id>\`.`,
    ].join("\n"));
  });

  test("names the app and its prefix when narrowed", () => {
    expect(appsAgentScopeNotice("xyz.tinycloud.health").split("\n")[0]).toBe(
      "This gives the agent access to the data of `xyz.tinycloud.health` (everything under `xyz.tinycloud.health/`) in the `applications` space.",
    );
  });
});

describe("resolveAppsAgentRequest", () => {
  test("no preset, no change", () => {
    expect(resolveAppsAgentRequest({ cap: ["tinycloud.kv:applications::get"] })).toBeUndefined();
  });

  test("accepts the preset alone, with or without an app", () => {
    expect(resolveAppsAgentRequest({ preset: "apps-agent" })).toEqual({});
    expect(resolveAppsAgentRequest({ preset: "apps-agent", app: "xyz.tinycloud.health" })).toEqual({ appId: "xyz.tinycloud.health" });
  });

  test("refuses anything that would make the printed scope untrue", () => {
    for (const options of [
      { app: "xyz.tinycloud.health" },
      { preset: "other" },
      { preset: "apps-agent", cap: ["tinycloud.kv:account::get"] },
      { preset: "apps-agent", permission: "p.json" },
      { preset: "apps-agent", manifest: "m.json" },
      { preset: "apps-agent", expiry: "30d" },
      { preset: "apps-agent", device: true },
      { preset: "apps-agent", app: "../account" },
      { preset: "apps-agent", app: "a/b" },
    ]) {
      expect(() => resolveAppsAgentRequest(options)).toThrow(expect.objectContaining({ exitCode: 2 }));
    }
  });
});

describe("matchAppsAgentRequest", () => {
  const qualified = (appId?: string) => appsAgentPermissions(appId).map((permission) => ({
    ...permission,
    space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
  }));

  test("recognises the preset, whole-space or per app, however the space is spelled and ordered", () => {
    expect(matchAppsAgentRequest(appsAgentPermissions())).toEqual({});
    expect(matchAppsAgentRequest(qualified().reverse())).toEqual({});
    expect(matchAppsAgentRequest(qualified("xyz.tinycloud.health"))).toEqual({ appId: "xyz.tinycloud.health" });
  });

  test("does not recognise a broader or different request", () => {
    const [kv, sql] = qualified();
    expect(matchAppsAgentRequest([{ ...kv!, actions: [...kv!.actions, "tinycloud.kv/del"] }, sql!])).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, actions: [...sql!.actions, "tinycloud.sql/admin"] }])).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, space: "account" }])).toBeUndefined();
    expect(matchAppsAgentRequest([kv!, { ...sql!, path: "other/" }])).toBeUndefined();
    expect(matchAppsAgentRequest([kv!])).toBeUndefined();
  });
});
