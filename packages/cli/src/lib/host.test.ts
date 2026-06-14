import { beforeEach, describe, expect, mock, test } from "bun:test";

// The owner's own address (Hardhat #0). A bare `--space applications` resolves
// against this; a full URI naming a DIFFERENT owner address makes the active
// profile a delegate.
const SELF_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_ADDR = "0xd559ccd9eb87c530a9a349262669386de93cf412";

let profile: Record<string, unknown> = {};
let session: Record<string, unknown> | null = null;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => profile,
    getSession: async () => session,
  },
}));

// Mirror the real resolveSpaceUri contract enough for resolveHostSpace: a bare
// name resolves against SELF_ADDR; a full URI passes through.
mock.module("./space.js", () => ({
  resolveSpaceUri: async (input: string | undefined) => {
    if (!input) return undefined;
    if (input.startsWith("tinycloud:")) return input;
    return `tinycloud:pkh:eip155:1:${SELF_ADDR}:${input}`;
  },
}));

const {
  isRootAuthority,
  ownerDidFromSpaceUri,
  spaceNameFromUri,
  resolveHostSpace,
  unhostedSpaceError,
} = await import("./host.js");

beforeEach(() => {
  profile = { name: "cli-test", address: SELF_ADDR, chainId: 1 };
  session = null;
});

describe("isRootAuthority", () => {
  test("true when the profile address owns the space DID", async () => {
    const uri = `tinycloud:pkh:eip155:1:${SELF_ADDR}:applications`;
    expect(await isRootAuthority(uri, "cli-test")).toBe(true);
  });

  test("false when the space DID names a different owner (delegate)", async () => {
    const uri = `tinycloud:pkh:eip155:1:${OTHER_ADDR}:applications`;
    expect(await isRootAuthority(uri, "cli-test")).toBe(false);
  });

  test("case-insensitive on the address comparison", async () => {
    const uri = `tinycloud:pkh:eip155:1:${SELF_ADDR.toUpperCase().replace("0X", "0x")}:applications`;
    expect(await isRootAuthority(uri, "cli-test")).toBe(true);
  });

  test("falls back to session.address then ownerDid", async () => {
    profile = { name: "p", chainId: 1, ownerDid: `did:pkh:eip155:1:${SELF_ADDR}` };
    const uri = `tinycloud:pkh:eip155:1:${SELF_ADDR}:applications`;
    expect(await isRootAuthority(uri, "p")).toBe(true);
  });

  test("delegate-session is NEVER root authority, even when ownerDid == the space owner", async () => {
    // A delegate legitimately knows the space owner's address (it's in ownerDid
    // / session.address). Posture must win so the delegate gets the host-request
    // hint, not the owner "tc space host" hint.
    profile = {
      name: "delegate",
      chainId: 1,
      posture: "delegate-session",
      ownerDid: `did:pkh:eip155:1:${OTHER_ADDR}`,
    };
    session = { address: OTHER_ADDR };
    const uri = `tinycloud:pkh:eip155:1:${OTHER_ADDR}:applications`;
    expect(await isRootAuthority(uri, "delegate")).toBe(false);
  });
});

describe("ownerDidFromSpaceUri / spaceNameFromUri", () => {
  test("extracts owner DID and space name", () => {
    const uri = `tinycloud:pkh:eip155:1:${OTHER_ADDR}:applications`;
    expect(ownerDidFromSpaceUri(uri)).toBe(`did:pkh:eip155:1:${OTHER_ADDR}`);
    expect(spaceNameFromUri(uri)).toBe("applications");
  });

  test("returns null for a non-pkh URI", () => {
    expect(ownerDidFromSpaceUri("tinycloud:weird:applications")).toBeNull();
  });
});

describe("resolveHostSpace", () => {
  test("resolves a bare name against the active profile", async () => {
    expect(await resolveHostSpace("applications", "cli-test")).toBe(
      `tinycloud:pkh:eip155:1:${SELF_ADDR}:applications`,
    );
  });
});

describe("unhostedSpaceError", () => {
  const OWNED = `tinycloud:pkh:eip155:1:${SELF_ADDR}:applications`;
  const DELEGATED = `tinycloud:pkh:eip155:1:${OTHER_ADDR}:applications`;

  function err(message: string, status?: number) {
    return { code: "SQL_DATABASE_NOT_FOUND", message, meta: { status } };
  }

  test("returns null when no space URI (primary space is always hosted)", async () => {
    const out = await unhostedSpaceError(err("404 - Space not found", 404), undefined, "cli-test");
    expect(out).toBeNull();
  });

  test("returns null for a 404 that is NOT a space-not-found body", async () => {
    // A missing table/db inside a hosted space must NOT be relabeled.
    const out = await unhostedSpaceError(
      err("SQL execute failed: 404 - no such table: feed", 404),
      DELEGATED,
      "cli-test",
    );
    expect(out).toBeNull();
  });

  test("returns null for a permission error (different status)", async () => {
    const out = await unhostedSpaceError(
      { code: "SQL_PERMISSION_DENIED", message: "403 - forbidden", meta: { status: 403 } },
      DELEGATED,
      "cli-test",
    );
    expect(out).toBeNull();
  });

  test("owner hint tells them to host directly", async () => {
    const out = await unhostedSpaceError(
      err("SQL execute failed: 404 - Space not found", 404),
      OWNED,
      "cli-test",
    );
    expect(out).not.toBeNull();
    expect(out!.code).toBe("SPACE_NOT_HOSTED");
    const hint = out!.metadata?.hint as string;
    expect(hint).toContain("You are the owner");
    expect(hint).toContain("tc space host applications");
    expect(hint).not.toContain("host-request");
  });

  test("delegate hint tells them they cannot host and to emit a host-request", async () => {
    const out = await unhostedSpaceError(
      err("SQL execute failed: 404 - Space not found", 404),
      DELEGATED,
      "cli-test",
    );
    expect(out).not.toBeNull();
    expect(out!.code).toBe("SPACE_NOT_HOSTED");
    const hint = out!.metadata?.hint as string;
    expect(hint).toContain("CANNOT host");
    expect(hint).toContain("tc space host-request applications --emit");
    // Identity-aware message names the owner, not the delegate.
    expect(out!.message).toContain(`did:pkh:eip155:1:${OTHER_ADDR}`);
  });

  test("matches the KV write unhosted shape too (status + message, any code)", async () => {
    const out = await unhostedSpaceError(
      { code: "KV_WRITE_FAILED", message: `Failed to put key "x": 404 - Space not found`, meta: { status: 404 } },
      DELEGATED,
      "cli-test",
    );
    expect(out).not.toBeNull();
    expect(out!.code).toBe("SPACE_NOT_HOSTED");
  });
});
