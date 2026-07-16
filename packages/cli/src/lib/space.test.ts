import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable profile the mocked ProfileManager returns. Each test sets defaultSpace.
let profile: Record<string, unknown> = {};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => profile,
    getSession: async () => null,
  },
}));

// bun's mock.module is global, so this mock can be the active @tinycloud/node-sdk
// while a sibling test file resolves its own source imports. Include stubs for
// every node-sdk *value* the CLI source imports (status.ts → NodeWasmBindings,
// secrets.ts → resolveSecret*, permissions.ts → expand/subset/resolveManifest)
// so no sibling import hits a missing export. The helpers space.ts uses carry
// real test behavior below.
mock.module("@tinycloud/node-sdk", () => ({
  canonicalizeAddress: (a: string) => a.toLowerCase(),
  makePkhSpaceId: (address: string, chainId: number, name: string) =>
    `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
  parsePkhDid: () => null,
  parseSpaceUri: (uri: string) => {
    // tinycloud:pkh:eip155:<chain>:<addr>:<name>
    const name = uri.slice(uri.lastIndexOf(":") + 1);
    const owner = uri.slice(0, uri.lastIndexOf(":"));
    return { owner, name };
  },
  buildSpaceUri: (owner: string, name: string) => `${owner}:${name}`,
  // Stubs so sibling test files don't break on this global mock:
  NodeWasmBindings: class NodeWasmBindings {},
  resolveSecretPath: () => ({}),
  resolveSecretListPrefix: () => "",
  expandActionShortNames: (_s: string, a: string[]) => a,
  isCapabilitySubset: () => ({ missing: [] }),
  resolveManifest: () => ({ resources: [] }),
  PrivateKeySigner: class PrivateKeySigner {},
  grantAuthRequest: () => ({}),
  pkhDid: () => "",
  principalDidEquals: () => false,
  TinyCloudNode: class TinyCloudNode {},
}));

// Export the full errors.js surface so a real import in any sibling test file
// resolving against this global mock never hits a missing-export error.
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
    ) {
      super(message);
    }
  },
  handleError: (error: unknown) => {
    throw error;
  },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

const { resolveSpaceUri } = await import("./space.js");

const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

describe("resolveSpaceUri default-space precedence", () => {
  beforeEach(() => {
    profile = {};
  });

  test("explicit --space overrides the profile default", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri("other", "p");
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:other`);
  });

  test("uses the profile default when --space is omitted", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri(undefined, "p");
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:applications`);
  });

  test("explicit --space matching the default resolves identically to omitting it", async () => {
    // Locks the invariant: with defaultSpace="applications", passing
    // "applications" explicitly must equal omitting --space entirely.
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const explicit = await resolveSpaceUri("applications", "p");
    const omitted = await resolveSpaceUri(undefined, "p");
    expect(explicit).toBe(omitted);
    expect(explicit).toBe(`tinycloud:pkh:eip155:1:${ADDR}:applications`);
  });

  test("falls back to the primary space (undefined) when no default and no flag", async () => {
    profile = { name: "p", address: ADDR, chainId: 1 };
    const uri = await resolveSpaceUri(undefined, "p");
    expect(uri).toBeUndefined();
  });

  test("a full URI flag is returned verbatim, ignoring the default", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri(
      `tinycloud:pkh:eip155:1:${ADDR}:explicit`,
      "p",
    );
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:explicit`);
  });

  test("preserves method-specific DID text containing an eip155-looking segment", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const didSpace = "tinycloud:did:web:EXAMPLE.com:eip155:1:0xABCDEF:Vault";
    await expect(resolveSpaceUri(didSpace, "p")).resolves.toBe(didSpace);
  });
});
