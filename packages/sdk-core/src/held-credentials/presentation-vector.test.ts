import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  HeldCredentialError,
  parseIssuerSet,
  pkhPrincipalsEqual,
  verifyHeldPresentation,
  type NonceStore,
} from "./index";
import { bytesToHex } from "./encoding";
import { selectDisclosures, sdHash } from "./credential";
import { buildHeldPresentationSiwe, checkReturnedPresentation } from "./presentation";

// A presentation built by buildHeldPresentationSiwe for audience `credentials.org` with a hex nonce, kept as a
// test vector in the case shape of OpenCredentials `held-presentation-v1/verifier-vectors.json`. The Rust
// verifier replays the same case; this file runs the TypeScript verifier, builder and check over it.
// The SIWE key is Anvil account 0: a public, well-known test key.
const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
const ANVIL_0_KEY = Uint8Array.from(Buffer.from("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "hex"));
const ANVIL_1_KEY = Uint8Array.from(Buffer.from("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "hex"));
const ANVIL_1_ACCOUNT = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const AUDIENCE = "credentials.org";
const NONCE = "a1b2c3d4e5f6a7b8c9d0e1f2";

interface Presentation { sdJwt: string; siwe: { message: string; signature: string } }
interface VectorCase {
  name: string;
  now_ms: number;
  audience: string;
  caller_account: string;
  accepted_issuers: { issuerDid: string }[];
  did_methods: string[];
  issuer_set: unknown;
  seeded_nonce: { audience: string; nonce: string; account: string };
  presentation: Presentation;
  expected: { ok: boolean; issuer: string; subject: string; claims: Record<string, string>; issued_at: number; expires_at: number };
}

const vector = (await Bun.file(new URL("held-presentation-v1/presentation.json", FIXTURE_DIR)).json()).case as VectorCase;
const sourceVector = await Bun.file(new URL("held-email-v1/vector.json", FIXTURE_DIR)).json();

function personalSign(message: string, key: Uint8Array): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const signature = secp256k1.sign(keccak_256(Uint8Array.from([...prefix, ...body])), key);
  return `0x${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
}

/** The harness semantics of the Rust SeededNonces: spent only when bound to the caller; otherwise left alone. */
class SeededNonces implements NonceStore {
  private readonly entries = new Map<string, string>();
  constructor(seeded: { audience: string; nonce: string; account: string }[]) {
    for (const s of seeded) this.entries.set(`${s.audience}\n${s.nonce}`, s.account);
  }
  async consume(audience: string, nonce: string, account: string): Promise<{ existed: boolean }> {
    const key = `${audience}\n${nonce}`;
    const bound = this.entries.get(key);
    if (bound === undefined || !pkhPrincipalsEqual(bound, account)) return { existed: false };
    this.entries.delete(key);
    return { existed: true };
  }
}

function verifyOptions(nonces: NonceStore, overrides: { audience?: string; callerAccount?: string } = {}) {
  return {
    now: new Date(vector.now_ms),
    audience: overrides.audience ?? vector.audience,
    callerAccount: overrides.callerAccount ?? vector.caller_account,
    issuerSet: parseIssuerSet(vector.issuer_set, { didMethods: { issuer: ["web"] } }),
    acceptedIssuers: vector.accepted_issuers,
    acceptedProfiles: [{ profile: "tinycloud.email-held/v1", profileVersion: 1 }],
    didMethods: { issuer: vector.did_methods },
    nonceStore: nonces,
  };
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

const seeded = () => new SeededNonces([vector.seeded_nonce]);

describe("held presentation vector (credentials.org, hex nonce)", () => {
  test("the fixture is exactly what buildHeldPresentationSiwe produces for the held-email-v1 credential", async () => {
    const sdJwt = selectDisclosures(sourceVector.sdJwt, ["email"]);
    const siwe = await buildHeldPresentationSiwe({
      audience: AUDIENCE,
      nonce: NONCE,
      sdHash: sdHash(sdJwt),
      account: sourceVector.account,
      issuedAt: new Date(new Date(sourceVector.now).getTime() - 60_000),
      sign: async (message) => personalSign(message, ANVIL_0_KEY),
    });
    expect(vector.presentation).toEqual({ sdJwt, siwe });
    expect(vector.audience).toBe(AUDIENCE);
    expect(vector.seeded_nonce).toEqual({ audience: AUDIENCE, nonce: NONCE, account: sourceVector.account });
    expect(NONCE).toMatch(/^[0-9a-f]{24}$/);
  });

  test("the TypeScript verifier accepts it and returns the expected summary", async () => {
    const result = await verifyHeldPresentation(vector.presentation, verifyOptions(seeded()));
    expect(result.issuer).toBe(vector.expected.issuer);
    expect(result.subject).toBe(vector.expected.subject);
    expect(result.claims).toEqual(vector.expected.claims);
    expect(result.expiresAt.getTime() / 1000).toBe(vector.expected.expires_at);
  });

  test("checkReturnedPresentation accepts it for the audience and account", () => {
    const checked = checkReturnedPresentation(vector.presentation, { now: new Date(vector.now_ms), audience: AUDIENCE, account: vector.caller_account });
    expect(checked).toEqual(vector.presentation);
  });

  test("a different domain is refused by the check and by the verifier", async () => {
    expect(await codeOf(() => checkReturnedPresentation(vector.presentation, { now: new Date(vector.now_ms), audience: "evil.example.com", account: vector.caller_account }))).toBe("bad-siwe");
    const nonces = new SeededNonces([vector.seeded_nonce, { ...vector.seeded_nonce, audience: "evil.example.com" }]);
    expect(await codeOf(() => verifyHeldPresentation(vector.presentation, verifyOptions(nonces, { audience: "evil.example.com" })))).toBe("bad-siwe");
  });

  test("the builder binds the domain it is given: a message for another domain does not pass the credentials.org check", async () => {
    const sdJwt = vector.presentation.sdJwt;
    const siwe = await buildHeldPresentationSiwe({
      audience: "evil.example.com",
      nonce: NONCE,
      sdHash: sdHash(sdJwt),
      account: vector.caller_account,
      issuedAt: new Date(vector.now_ms - 60_000),
      sign: async (message) => personalSign(message, ANVIL_0_KEY),
    });
    expect(await codeOf(() => checkReturnedPresentation({ sdJwt, siwe }, { now: new Date(vector.now_ms), audience: AUDIENCE, account: vector.caller_account }))).toBe("bad-siwe");
  });

  test("a replayed nonce is refused on the second presentation", async () => {
    const nonces = seeded();
    await verifyHeldPresentation(vector.presentation, verifyOptions(nonces));
    expect(await codeOf(() => verifyHeldPresentation(vector.presentation, verifyOptions(nonces)))).toBe("nonce-replayed");
  });

  test("a presentation under a nonce the verifier never issued is refused as replayed", async () => {
    expect(await codeOf(() => verifyHeldPresentation(vector.presentation, verifyOptions(new SeededNonces([]))))).toBe("nonce-replayed");
  });

  test("a different account cannot use the presentation: the verifier, the check and the builder all refuse", async () => {
    // The nonce is bound to account 0; a caller that is account 1 cannot spend it.
    expect(await codeOf(() => verifyHeldPresentation(vector.presentation, verifyOptions(seeded(), { callerAccount: ANVIL_1_ACCOUNT })))).toBe("nonce-replayed");
    // Even with a nonce bound to account 1, the credential subject is account 0.
    const bound = new SeededNonces([{ ...vector.seeded_nonce, account: ANVIL_1_ACCOUNT }]);
    expect(await codeOf(() => verifyHeldPresentation(vector.presentation, verifyOptions(bound, { callerAccount: ANVIL_1_ACCOUNT })))).toBe("nonce-account-mismatch");
    expect(await codeOf(() => checkReturnedPresentation(vector.presentation, { now: new Date(vector.now_ms), audience: AUDIENCE, account: ANVIL_1_ACCOUNT }))).toBe("bad-siwe");
    // A signer that does not control the named account is refused before anything is returned.
    const forged = () => buildHeldPresentationSiwe({
      audience: AUDIENCE,
      nonce: NONCE,
      sdHash: sdHash(vector.presentation.sdJwt),
      account: vector.caller_account,
      issuedAt: new Date(vector.now_ms - 60_000),
      sign: async (message) => personalSign(message, ANVIL_1_KEY),
    });
    expect(await codeOf(forged)).toBe("bad-siwe-signature");
  });

  test("the builder refuses a nonce that is not base62 and one shorter than 22 characters", async () => {
    const build = (nonce: string) => buildHeldPresentationSiwe({
      audience: AUDIENCE,
      nonce,
      sdHash: sdHash(vector.presentation.sdJwt),
      account: vector.caller_account,
      issuedAt: new Date(vector.now_ms - 60_000),
      sign: async (message) => personalSign(message, ANVIL_0_KEY),
    });
    expect(await codeOf(() => build("a1b2c3d4e5f6a7b8c9d0e1f-"))).toBe("bad-config");
    expect(await codeOf(() => build("a1b2c3d4e5f6a7b8c9d0e"))).toBe("bad-config");
  });
});
