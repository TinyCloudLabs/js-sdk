import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CLIError } from "../output/errors.js";

// Controllable profile/session/key state for each test. `null` means "absent"
// — `getProfile` throws (as the real ProfileManager does) when no profile.json
// exists, so a headless delegate has no profile, no session, and no key.
let profile: Record<string, unknown> | null = null;
let session: Record<string, unknown> | null = null;
let key: object | null = null;
const savedSessions: Record<string, unknown>[] = [];
const savedProfiles: Record<string, unknown>[] = [];

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
    setSession: async (_name: string, next: Record<string, unknown>) => {
      session = next;
      savedSessions.push(next);
    },
    setProfile: async (_name: string, next: Record<string, unknown>) => {
      profile = next;
      savedProfiles.push(next);
    },
  },
}));

// Record TinyCloudNode construction + signIn so tests can assert the headless
// key path actually builds and signs in a node.
const nodeCalls: { privateKey?: string; signedIn: boolean }[] = [];

// Record restoreSession args (specifically the jwk handed to the WASM signer)
// so tests can assert the public-only-session-jwk fallback to key.json works.
const restoreCalls: Array<{ jwk: unknown }> = [];

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
    async restoreSession(args: { jwk: unknown }) {
      restoreCalls.push({ jwk: args.jwk });
    }
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

const { bootstrapDelegatedSession, ensureAuthenticated, jwkHasPrivateParameter, selectSignerJwk } = await import("./sdk.js");

const ctx = { profile: "tc-sdk-test-headless", host: "https://node.tinycloud.xyz", verbose: false, noCache: false, quiet: false };
const HEX_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

beforeEach(() => {
  profile = null;
  session = null;
  key = null;
  nodeCalls.length = 0;
  restoreCalls.length = 0;
  savedSessions.length = 0;
  savedProfiles.length = 0;
  delete process.env.TC_PRIVATE_KEY;
});

describe("bootstrapDelegatedSession", () => {
  const FULL_KEY_JWK = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
  const delegation = {
    delegationHeader: { Authorization: "Bearer delegated" },
    cid: "bafy-delegated-session",
    spaceId: "tinycloud:pkh:eip155:1:0xowner",
    delegateDID: "did:key:zDelegate#zDelegate",
    ownerAddress: "0xowner",
    chainId: 1,
  };

  test("persists and restores the first session for a delegate profile", async () => {
    profile = {
      name: ctx.profile,
      posture: "delegate-session",
      did: "did:key:zDelegate",
      sessionDid: "did:key:zDelegate",
    };
    key = FULL_KEY_JWK;

    await bootstrapDelegatedSession(ctx, delegation as never);

    expect(savedSessions).toHaveLength(1);
    expect(savedSessions[0]).toMatchObject({
      delegationCid: "bafy-delegated-session",
      verificationMethod: "did:key:zDelegate",
      jwk: FULL_KEY_JWK,
    });
    expect(savedProfiles[0]).toMatchObject({
      spaceId: "tinycloud:pkh:eip155:1:0xowner",
      sessionDid: "did:key:zDelegate",
    });
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.jwk).toBe(FULL_KEY_JWK);
  });

  test("rejects a delegation issued to a different session key", async () => {
    profile = {
      name: ctx.profile,
      posture: "delegate-session",
      did: "did:key:zOther",
      sessionDid: "did:key:zOther",
    };
    key = FULL_KEY_JWK;

    const error = await bootstrapDelegatedSession(ctx, delegation as never)
      .catch((cause) => cause as CLIError);

    expect(error.code).toBe("DELEGATION_AUDIENCE_MISMATCH");
    expect(savedSessions).toHaveLength(0);
    expect(restoreCalls).toHaveLength(0);
  });
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

describe("selectSignerJwk fallback", () => {
  const PUBLIC_ONLY_SESSION_JWK = { kty: "OKP", crv: "Ed25519", x: "session-public" };
  const FULL_KEY_JWK = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
  const FULL_SESSION_JWK = { kty: "OKP", crv: "Ed25519", x: "session-public", d: "session-private" };

  test("jwkHasPrivateParameter returns false for a public-only OKP JWK", () => {
    expect(jwkHasPrivateParameter(PUBLIC_ONLY_SESSION_JWK)).toBe(false);
  });

  test("jwkHasPrivateParameter returns true when `d` is present", () => {
    expect(jwkHasPrivateParameter(FULL_KEY_JWK)).toBe(true);
  });

  test("jwkHasPrivateParameter is defensive against null/undefined/empty `d`", () => {
    expect(jwkHasPrivateParameter(null)).toBe(false);
    expect(jwkHasPrivateParameter(undefined)).toBe(false);
    expect(jwkHasPrivateParameter({ kty: "OKP", crv: "Ed25519", x: "p", d: "" })).toBe(false);
  });

  test("selectSignerJwk prefers session JWK when it has `d`", () => {
    expect(selectSignerJwk(FULL_SESSION_JWK, FULL_KEY_JWK)).toBe(FULL_SESSION_JWK);
  });

  test("selectSignerJwk falls back to key when session JWK is public-only", () => {
    expect(selectSignerJwk(PUBLIC_ONLY_SESSION_JWK, FULL_KEY_JWK)).toBe(FULL_KEY_JWK);
  });

  test("selectSignerJwk falls back to key when session JWK is missing", () => {
    expect(selectSignerJwk(undefined, FULL_KEY_JWK)).toBe(FULL_KEY_JWK);
  });
});

describe("ensureAuthenticated restoreSession uses full keypair from key.json", () => {
  // This is the regression guard for the JWK-private-fallback bug: a
  // session.json carrying a public-only JWK (because OpenKey echoed back the
  // stripped delegation key) used to be handed verbatim to the WASM signer,
  // which then threw `Missing private key parameter in JWK` on every
  // tc kv / tc sql call. The fix in sdk.ts must prefer key.json instead.
  const FULL_KEY_JWK = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
  const PUBLIC_ONLY_SESSION_JWK = { kty: "OKP", crv: "Ed25519", x: "session-public" };
  const sessionShell = {
    delegationHeader: { Authorization: "Bearer x" },
    delegationCid: "bafy-session",
    spaceId: "tinycloud:space",
    verificationMethod: "did:key:zSession",
  };

  test("OpenKey path: public-only session.jwk falls back to key.json (the full keypair)", async () => {
    profile = { authMethod: "openkey", did: "did:key:zSession" };
    session = { ...sessionShell, jwk: PUBLIC_ONLY_SESSION_JWK };
    key = FULL_KEY_JWK;

    await ensureAuthenticated(ctx);

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.jwk).toBe(FULL_KEY_JWK);
    expect((restoreCalls[0]!.jwk as { d?: string }).d).toBe("key-private");
  });

  test("OpenKey path: session.jwk that already has `d` is preserved", async () => {
    profile = { authMethod: "openkey", did: "did:key:zSession" };
    const fullSessionJwk = { kty: "OKP", crv: "Ed25519", x: "session-public", d: "session-private" };
    session = { ...sessionShell, jwk: fullSessionJwk };
    key = FULL_KEY_JWK;

    await ensureAuthenticated(ctx);

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.jwk).toBe(fullSessionJwk);
  });

  test("local-auth path: public-only session.jwk also falls back to key.json", async () => {
    profile = { authMethod: "local", privateKey: "0xowner", did: "did:pkh:eip155:1:0xowner", sessionDid: "did:key:zSession" };
    session = { ...sessionShell, jwk: PUBLIC_ONLY_SESSION_JWK };
    key = FULL_KEY_JWK;

    await ensureAuthenticated(ctx);

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.jwk).toBe(FULL_KEY_JWK);
  });

  test("an unrecoverable public-only session is rejected as auth state before restore", async () => {
    profile = { authMethod: "openkey", did: "did:key:zSession" };
    session = { ...sessionShell, jwk: PUBLIC_ONLY_SESSION_JWK };
    key = { kty: "OKP", crv: "Ed25519", x: "key-public" };

    const error = await ensureAuthenticated(ctx).catch((cause) => cause as CLIError);
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.exitCode).toBe(3);
    expect(error.metadata?.hint).toBe(
      "Sign in again with: tc --profile tc-sdk-test-headless auth login --method openkey",
    );
    expect(restoreCalls).toHaveLength(0);
  });
});
