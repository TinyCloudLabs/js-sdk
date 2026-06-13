import { beforeEach, describe, expect, mock, test } from "bun:test";

// Records the (address, chainId, name) that makePkhSpaceId is called with so we
// can assert which NAME the resolver ultimately resolved.
const recorded = {
  pkhCalls: [] as Array<{ address: string; chainId: number; name: string }>,
};

function resetState(): void {
  recorded.pkhCalls = [];
}

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
  makePkhSpaceId: (address: string, chainId: number, name: string) => {
    recorded.pkhCalls.push({ address, chainId, name });
    return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
  },
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
  beforeEach(resetState);

  test("explicit --space overrides the profile default", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri("other", "p");
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:other`);
    expect(recorded.pkhCalls.map((c) => c.name)).toEqual(["other"]);
  });

  test("uses the profile default when --space is omitted", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri(undefined, "p");
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:applications`);
    expect(recorded.pkhCalls.map((c) => c.name)).toEqual(["applications"]);
  });

  test("falls back to the primary space (undefined) when no default and no flag", async () => {
    profile = { name: "p", address: ADDR, chainId: 1 };
    const uri = await resolveSpaceUri(undefined, "p");
    expect(uri).toBeUndefined();
    expect(recorded.pkhCalls).toEqual([]);
  });

  test("a full URI flag is returned verbatim, ignoring the default", async () => {
    profile = { name: "p", address: ADDR, chainId: 1, defaultSpace: "applications" };
    const uri = await resolveSpaceUri(
      `tinycloud:pkh:eip155:1:${ADDR}:explicit`,
      "p",
    );
    expect(uri).toBe(`tinycloud:pkh:eip155:1:${ADDR}:explicit`);
    // URI path doesn't go through makePkhSpaceId.
    expect(recorded.pkhCalls).toEqual([]);
  });
});
