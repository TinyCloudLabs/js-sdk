import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
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

  test("unscoped replication login preserves the complete KV, SQL, and capability defaults", () => {
    const result = buildReplicationLoginRequest(undefined, { prefixes: ["notes"] })!;
    expect(result).toContainEqual({
      service: "tinycloud.sql",
      space: "default",
      path: "",
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    });
    expect(result).toContainEqual({
      service: "tinycloud.capabilities",
      space: "default",
      path: "",
      actions: ["tinycloud.capabilities/read"],
    });
    expect(result.find((entry) => entry.path === "notes" && entry.actions.includes("tinycloud.kv/sync"))).toBeDefined();
  });
describe("replication login scope", () => {
  test("adds sync to an unscoped default login and owner-qualified default login", () => {
    const anonymous = buildReplicationLoginRequest(undefined, { prefixes: ["notes"] })!;
    expect(anonymous.find((entry) => entry.path === "notes" && entry.actions.includes("tinycloud.kv/sync"))?.space).toBe("default");
    const qualified = buildReplicationLoginRequest(undefined, { prefixes: ["notes"], ownerDid: owner })!;
    expect(qualified.find((entry) => entry.path === "notes" && entry.actions.includes("tinycloud.kv/sync"))?.space)
      .toBe(`tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default`);
  });

  test("exact-only get refuses replication and leaves the login request unchanged", () => {
    const request = [get("notes")];
    const before = structuredClone(request);
    try {
      buildReplicationLoginRequest(request, { prefixes: ["notes/"] });
      throw new Error("expected replication scope refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "REPLICATION_PREFIX_OUTSIDE_SCOPE", exitCode: 2 });
    }
    expect(request).toEqual(before);
    expect(buildReplicationLoginRequest([get("notes/")], { prefixes: ["notes/"] }))
      .toContainEqual(expect.objectContaining({ path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] }));
  });
  test("replication eligibility follows exact and trailing-slash containment", () => {
    for (const prefix of ["notes/", "notes/private", "notesX"]) {
      expect(codeOf(() => buildReplicationLoginRequest([get("notes")], { prefixes: [prefix] })))
        .toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
    }
    expect(codeOf(() => buildReplicationLoginRequest([get("notes")], { prefixes: ["notes"] }))).toBeUndefined();
    for (const prefix of ["notes/a", "notes/a/b"]) {
      expect(codeOf(() => buildReplicationLoginRequest([get("notes/")], { prefixes: [prefix] })))
        .toBeUndefined();
    }
    expect(codeOf(() => buildReplicationLoginRequest([get("notes/")], { prefixes: ["notes"] })))
      .toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
  });


  test("keeps a narrow manifest narrow and normalizes matching short and full spaces", () => {
    const full = `tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications`;
    const request = [get("apps/", "applications")];
    const result = addReplicationLoginEntries(request, full, { prefixes: ["apps/notes"], ownerDid: owner });
    expect(result.filter((entry) => !entry.actions.includes("tinycloud.capabilities/read"))).toHaveLength(2);
    expect(result.at(-1)).toMatchObject({ space: full, path: "apps/notes", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] });
    expect(sameLoginSpace("applications", full, owner)).toBe(true);
    const otherOwnerSpace = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:default";
    expect(sameLoginSpace(otherOwnerSpace, "default", owner)).toBe(false);
    expect(sameLoginSpace(otherOwnerSpace, "default")).toBe(true);
    expect(codeOf(() => addReplicationLoginEntries(request, full, { prefixes: ["other"], ownerDid: owner })))
      .toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
  });

  test("refuses a caveated-only covering get without mutating the manifest", () => {
    const caveated = get("notes/", "default", [{ tenant: "alpha" }]);
    const manifest = [caveated];
    expect(codeOf(() => addReplicationLoginEntries(manifest, "default", { prefixes: ["notes/a"] })))
      .toBe("REPLICATION_PREFIX_CAVEATED");
    expect(manifest).toEqual([caveated]);
    expect(codeOf(() => addReplicationLoginEntries(manifest, "default", { prefixes: ["other"] })))
      .toBe("REPLICATION_PREFIX_OUTSIDE_SCOPE");
  });

  test("an unrestricted matching get permits augmentation despite another caveat, and empty caveats are unrestricted", () => {
    const request = [get("", "default", [{ tenant: "alpha" }]), get("notes/")];
    expect(addReplicationLoginEntries(request, "default", { prefixes: ["notes/a"] }).at(-1)?.actions)
      .toEqual(["tinycloud.kv/get", "tinycloud.kv/sync"]);
    for (const caveats of [[], [{}]]) {
      expect(addReplicationLoginEntries([get("", "default", caveats)], "default", { prefixes: ["notes"] }).at(-1)?.actions)
        .toContain("tinycloud.kv/sync");
    }
    expect(codeOf(() => addReplicationLoginEntries([get("", "default", [{ tenant: "alpha" }])], "default", { prefixes: ["other"] })))
      .toBe("REPLICATION_PREFIX_CAVEATED");
  });

  test("requires explicit secret opt-in on secret spaces and vault prefixes", () => {
    expect(codeOf(() => addReplicationLoginEntries([get("")], "default", { prefixes: ["vault/items"] })))
      .toBe("SECRETS_OPT_IN_REQUIRED");
    expect(codeOf(() => addReplicationLoginEntries([get("")], "default", { prefixes: ["vault/items"], allowSecrets: true })))
      .toBeUndefined();
    expect(codeOf(() => addReplicationLoginEntries([get("", "secrets")], "secrets", { prefixes: ["notes"] })))
      .toBe("SECRETS_OPT_IN_REQUIRED");
  });
});
