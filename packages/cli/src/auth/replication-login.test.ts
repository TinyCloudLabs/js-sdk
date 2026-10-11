import { isCapabilitySubset, type PermissionEntry } from "@tinycloud/sdk-core";
import { describe, expect, test } from "bun:test";
import { CLIError } from "../output/errors.js";
import { addReplicationLoginEntries, buildReplicationLoginRequest } from "./replication-login.js";
import { sameLoginSpace } from "./scoped-login.js";

const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const get = (path: string, space = "default", caveats?: Record<string, unknown>[]): PermissionEntry => ({
  service: "tinycloud.kv",
  space,
  path,
  actions: ["tinycloud.kv/get"],
  ...(caveats === undefined ? {} : { caveats }),
});

function codeOf(action: () => unknown): string | undefined {
  try { action(); } catch (error) { return error instanceof CLIError ? error.code : undefined; }
  return undefined;
}

describe("replication login folder prefixes", () => {
  test("a slash grant is augmented by one get+sync entry", () => {
    const result = buildReplicationLoginRequest([get("notes/")], { prefixes: ["notes/"] })!;
    expect(result.filter((entry) => entry.actions.includes("tinycloud.kv/sync"))).toEqual([
      { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
  });

  test("unscoped login preserves KV, SQL, and capability defaults for owner-qualified spaces", () => {
    const result = buildReplicationLoginRequest(undefined, { prefixes: ["notes/"] })!;
    expect(result).toContainEqual({ service: "tinycloud.sql", space: "default", path: "", actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] });
    expect(result).toContainEqual({ service: "tinycloud.capabilities", space: "default", path: "", actions: ["tinycloud.capabilities/read"] });
    expect(result).toContainEqual({ service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] });
    const qualified = buildReplicationLoginRequest(undefined, { prefixes: ["notes/"], ownerDid: owner })!;
    expect(qualified.find((entry) => entry.actions.includes("tinycloud.kv/sync"))?.space)
      .toBe("tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default");
  });

  test("one unrestricted get covers despite other caveats; empty caveat sets are unrestricted", () => {
    const mixed = addReplicationLoginEntries([
      get("", "default", [{ tenant: "alpha" }]),
      get("notes/"),
    ], "default", { prefixes: ["notes/private/"] });
    expect(mixed.at(-1)?.path).toBe("notes/private/");
    for (const caveats of [[], [{}]]) {
      expect(addReplicationLoginEntries([get("", "default", caveats)], "default", { prefixes: ["notes/"] }).at(-1)?.actions)
        .toContain("tinycloud.kv/sync");
    }
  });

  test("rejects bare prefixes as usage errors and preserves the request", () => {
    const request = [get("")];
    const before = structuredClone(request);
    expect(codeOf(() => buildReplicationLoginRequest(request, { prefixes: ["notes"] }))).toBe("INVALID_REPLICATION_PREFIX");
    expect(request).toEqual(before);
    try {
      buildReplicationLoginRequest(request, { prefixes: ["notes"] });
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 2 });
      expect((error as Error).message).toContain("notes/");
    }
  });

  test("an exact-key get cannot cover a folder; the request remains unchanged", () => {
    const request = [get("notes")];
    const before = structuredClone(request);
    expect(codeOf(() => buildReplicationLoginRequest(request, { prefixes: ["notes/"] }))).toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
    expect(request).toEqual(before);
  });

  test("caveated grants refuse, while unrestricted ancestor grants cover", () => {
    expect(codeOf(() => addReplicationLoginEntries([get("notes/", "default", [{ tenant: "alpha" }])], "default", { prefixes: ["notes/private/"] })))
      .toBe("REPLICATION_PREFIX_CAVEATED");
    const full = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
    const result = addReplicationLoginEntries([get("apps/", "applications")], full, { prefixes: ["apps/notes/"] , ownerDid: owner });
    expect(result.at(-1)).toEqual({ service: "tinycloud.kv", space: full, path: "apps/notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] });
    expect(isCapabilitySubset([get("apps/notes/", full)], result).subset).toBe(true);
    expect(sameLoginSpace("applications", full, owner)).toBe(true);
    expect(codeOf(() => addReplicationLoginEntries([get("")], full, { prefixes: ["other/"], ownerDid: owner })))
      .toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
  });

  test("requires secret opt-in on secret spaces and vault folders", () => {
    expect(codeOf(() => addReplicationLoginEntries([get("")], "default", { prefixes: ["vault/items/"] })))
      .toBe("SECRETS_OPT_IN_REQUIRED");
    expect(codeOf(() => addReplicationLoginEntries([get("")], "default", { prefixes: ["vault/items/"], allowSecrets: true })))
      .toBeUndefined();
    expect(codeOf(() => addReplicationLoginEntries([get("", "secrets")], "secrets", { prefixes: ["notes/"] })))
      .toBe("SECRETS_OPT_IN_REQUIRED");
  });
});
