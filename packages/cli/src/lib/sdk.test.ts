import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CLIError } from "../output/errors.js";

// Controllable profile/session/key state for each test. `null` means "absent"
// — `getProfile` throws (as the real ProfileManager does) when no profile.json
// exists, so a headless delegate has no profile, no session, and no key.
let profile: Record<string, unknown> | null = null;
let session: Record<string, unknown> | null = null;
let key: object | null = null;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => {
      if (profile === null) {
        throw new CLIError("PROFILE_NOT_FOUND", "Profile does not exist.");
      }
      return profile;
    },
    getSession: async () => session,
    getKey: async () => key,
  },
}));

// Record TinyCloudNode construction + signIn so tests can assert the headless
// key path actually builds and signs in a node.
const nodeCalls: { privateKey?: string; signedIn: boolean }[] = [];

mock.module("@tinycloud/node-sdk", () => ({
  TinyCloudNode: class {
    private _call: { privateKey?: string; signedIn: boolean };
    constructor(opts: { host: string; privateKey?: string }) {
      this._call = { privateKey: opts.privateKey, signedIn: false };
      nodeCalls.push(this._call);
    }
    async signIn() {
      this._call.signedIn = true;
    }
    async restoreSession() {}
  },
}));

// sdk.js -> permissions.js -> sdk-core/manifest.js pulls in the published
// @tinycloud/sdk-services dist, whose build is currently broken on import.
// Stub the one symbol the resolver needs (replayAdditionalDelegations) so the
// gate under test imports cleanly without that chain. Other CLI test files
// already mock ../lib/permissions.js the same way.
mock.module("./permissions.js", () => ({
  replayAdditionalDelegations: async () => {},
}));

const { ensureAuthenticated } = await import("./sdk.js");

const ctx = { profile: "tc-sdk-test-headless", host: "https://node.tinycloud.xyz", verbose: false, noCache: false, quiet: false };
const HEX_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

beforeEach(() => {
  profile = null;
  session = null;
  key = null;
  nodeCalls.length = 0;
  delete process.env.TC_PRIVATE_KEY;
});

afterEach(() => {
  delete process.env.TC_PRIVATE_KEY;
});

describe("ensureAuthenticated headless private-key identity", () => {
  test("an explicit options.privateKey authenticates with NO profile and NO session", async () => {
    const node = await ensureAuthenticated(ctx, { privateKey: HEX_KEY });
    expect(node).toBeDefined();
    // The headless path builds a node from the key and signs in.
    expect(nodeCalls).toHaveLength(1);
    expect(nodeCalls[0]!.privateKey).toBe(HEX_KEY);
    expect(nodeCalls[0]!.signedIn).toBe(true);
  });

  test("a key sourced from TC_PRIVATE_KEY (threaded as options.privateKey) authenticates headlessly", async () => {
    // This is the shape the secrets commands produce: authOptions() reads
    // TC_PRIVATE_KEY and passes it to ensureAuthenticated as options.privateKey.
    process.env.TC_PRIVATE_KEY = HEX_KEY;
    const fromEnv = process.env.TC_PRIVATE_KEY;
    const node = await ensureAuthenticated(ctx, { privateKey: fromEnv });
    expect(node).toBeDefined();
    expect(nodeCalls).toHaveLength(1);
    expect(nodeCalls[0]!.privateKey).toBe(HEX_KEY);
    expect(nodeCalls[0]!.signedIn).toBe(true);
  });

  test("with no profile, no session, and no key, it still throws AUTH_REQUIRED", async () => {
    await expect(ensureAuthenticated(ctx, {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(nodeCalls).toHaveLength(0);
  });

  test("with no profile, no session, and no options, it throws AUTH_REQUIRED", async () => {
    await expect(ensureAuthenticated(ctx)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test("an explicit key wins even when a local profile already exists", async () => {
    profile = { authMethod: "local", privateKey: "0xother", did: "did:pkh:eip155:1:0xowner" };
    const node = await ensureAuthenticated(ctx, { privateKey: HEX_KEY });
    expect(node).toBeDefined();
    // The provided key, not the profile's stored key, builds the node.
    expect(nodeCalls.some((c) => c.privateKey === HEX_KEY)).toBe(true);
    expect(nodeCalls.some((c) => c.privateKey === "0xother")).toBe(false);
  });
});
