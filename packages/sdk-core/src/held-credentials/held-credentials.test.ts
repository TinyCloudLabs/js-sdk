import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import {
  HeldCredentialError,
  InMemoryNonceStore,
  PRESENTATION_STATEMENT,
  normaliseEmail,
  parseIssuerSet,
  pkhPrincipalsEqual,
  registryKey,
  toChecksumAddress,
  verifyHeldPresentation,
  type NonceStore,
  type VerifyHeldPresentationOptions,
} from "./index";
import { asciiBytes, bytesToHex, encodeBase64Url } from "./encoding";
import { EMAIL_HELD_ROW } from "./rows";

const enc = (value: unknown) => encodeBase64Url(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);

const ISSUER_A = "did:web:issuer.credentials.org";
const KID_A = `${ISSUER_A}#issuing-1`;
const ISSUER_B = "did:web:orgb.credentials.org";
const KID_B = `${ISSUER_B}#issuing-1`;
const SEED_A = seed(1);
const SEED_B = seed(100);
const AUDIENCE = "billing.tinycloud.xyz";
const NOW = new Date("2026-10-20T00:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const DAY = 86400;
const PROFILE = "tinycloud.email-held/v1";
const VCT = "opencredentials.email/v1";
const BINDING = "tinycloud.credentials/account-binding/v1";

const holderKey = secp256k1.utils.randomPrivateKey();
const addressOf = (priv: Uint8Array) => `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`;
const HOLDER_LOWER = addressOf(holderKey);
const HOLDER = toChecksumAddress(HOLDER_LOWER);
const SUB = `did:pkh:eip155:1:${HOLDER}`;
const otherKey = secp256k1.utils.randomPrivateKey();

function personalSign(message: string, priv: Uint8Array): string {
  const body = new TextEncoder().encode(message);
  const prefix = asciiBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak_256(Uint8Array.from([...prefix, ...body]));
  const sig = secp256k1.sign(digest, priv);
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
}

type Obj = Record<string, unknown>;
interface CredentialSpec {
  seed?: Uint8Array;
  header?: (h: Obj) => Obj;
  payload?: (p: Obj) => Obj;
  disclosures?: [string, unknown][];
  rawDisclosures?: string[];
  signature?: (sig: Uint8Array) => Uint8Array;
  kid?: string;
  iss?: string;
}

function disclosure(name: string, value: unknown, salt = "salt-" + name) {
  const text = enc(JSON.stringify([salt, name, value]));
  return { text, digest: encodeBase64Url(sha256(asciiBytes(text))) };
}

function makeCredential(spec: CredentialSpec = {}) {
  const disclosures = (spec.disclosures ?? [["email", "alice@example.com"], ["emailDomain", "example.com"]]).map(([n, v]) => disclosure(n, v));
  const iat = NOW_S - 1000;
  let payload: Obj = {
    iss: spec.iss ?? ISSUER_A, sub: SUB, iat, nbf: iat, exp: iat + 365 * DAY, jti: "urn:uuid:11111111-1111-4111-8111-111111111111",
    vct: VCT, profile: PROFILE, profileVersion: 1, holderBinding: { did: SUB, signingDomain: BINDING },
    status: { method: "none" }, _sd_alg: "sha-256", _sd: disclosures.map((d) => d.digest),
  };
  if (spec.payload) payload = spec.payload(payload);
  let header: Obj = { alg: "EdDSA", typ: "vc+sd-jwt", kid: spec.kid ?? KID_A };
  if (spec.header) header = spec.header(header);
  const signingInput = `${enc(header)}.${enc(payload)}`;
  let signature = ed25519.sign(asciiBytes(signingInput), spec.seed ?? SEED_A);
  if (spec.signature) signature = spec.signature(signature);
  const jwt = `${signingInput}.${encodeBase64Url(signature)}`;
  const parts = [jwt, ...disclosures.map((d) => d.text), ...(spec.rawDisclosures ?? [])];
  return { jwt, sdJwt: `${parts.join("~")}~`, payload };
}

interface SiweSpec {
  domain?: string; address?: string; uri?: string; version?: string; chainId?: string; nonce?: string; statement?: string;
  resources?: string[] | null; expirationTime?: string; notBefore?: string; signer?: Uint8Array;
}

function makeSiwe(sdJwt: string, nonce: string, spec: SiweSpec = {}) {
  const sdHash = encodeBase64Url(sha256(asciiBytes(sdJwt)));
  const resources = spec.resources === undefined ? [`urn:tinycloud:sd-hash:${sdHash}`] : spec.resources ?? [];
  const lines = [
    `${spec.domain ?? AUDIENCE} wants you to sign in with your Ethereum account:`, spec.address ?? HOLDER, "", spec.statement ?? PRESENTATION_STATEMENT, "",
    `URI: ${spec.uri ?? `https://${AUDIENCE}`}`, `Version: ${spec.version ?? "1"}`, `Chain ID: ${spec.chainId ?? "1"}`, `Nonce: ${spec.nonce ?? nonce}`,
    "Issued At: 2026-10-19T23:59:00.000Z",
  ];
  if (spec.expirationTime) lines.push(`Expiration Time: ${spec.expirationTime}`);
  if (spec.notBefore) lines.push(`Not Before: ${spec.notBefore}`);
  if (resources.length) lines.push("Resources:", ...resources.map((r) => `- ${r}`));
  const message = lines.join("\n");
  return { message, signature: personalSign(message, spec.signer ?? holderKey) };
}

function entryA(extra: Obj = {}): Obj {
  return {
    issuerDid: ISSUER_A, kid: KID_A, alg: "EdDSA", publicKey: encodeBase64Url(ed25519.getPublicKey(SEED_A)),
    vcts: [VCT], profiles: [PROFILE], notBefore: "2026-10-01T00:00:00Z", retiredAt: null, notAfter: null, ...extra,
  };
}
function entryB(extra: Obj = {}): Obj {
  return entryA({ issuerDid: ISSUER_B, kid: KID_B, publicKey: encodeBase64Url(ed25519.getPublicKey(SEED_B)), ...extra });
}
const setOf = (...entries: Obj[]) => ({ format: "tinycloud.credentials-issuers/v1", version: 1, issuers: entries });
const METHODS = { issuer: ["web"] };

interface Harness { options: VerifyHeldPresentationOptions; store: InMemoryNonceStore; present: (cred?: CredentialSpec, siwe?: SiweSpec, mint?: string) => { presentation: { sdJwt: string; siwe: { message: string; signature: string } }; nonce: string } }
function harness(overrides: Partial<VerifyHeldPresentationOptions> = {}, entries: Obj[] = [entryA()]): Harness {
  const store = new InMemoryNonceStore();
  const options: VerifyHeldPresentationOptions = {
    now: NOW, issuerSet: parseIssuerSet(setOf(...entries), { didMethods: METHODS }),
    acceptedIssuers: [{ issuerDid: ISSUER_A }], acceptedProfiles: [{ profile: PROFILE, profileVersion: 1 }],
    didMethods: METHODS, audience: AUDIENCE, nonceStore: store, callerAccount: SUB, ...overrides,
  };
  return {
    options, store,
    present(cred, siwe, mint) {
      const nonce = store.issue(options.audience, mint ?? options.callerAccount);
      const { sdJwt } = makeCredential(cred);
      return { presentation: { sdJwt, siwe: makeSiwe(sdJwt, nonce, siwe) }, nonce };
    },
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) { if (error instanceof HeldCredentialError) return error.code; throw error; }
}
async function expectCode(expected: string, cred?: CredentialSpec, siwe?: SiweSpec, overrides: Partial<VerifyHeldPresentationOptions> = {}, entries?: Obj[]) {
  const h = harness(overrides, entries);
  const { presentation } = h.present(cred, siwe);
  expect(await code(verifyHeldPresentation(presentation, h.options))).toBe(expected);
}

describe("valid presentation", () => {
  test("verifies and returns only derived values", async () => {
    const h = harness();
    const { presentation } = h.present();
    const result = await verifyHeldPresentation(presentation, h.options);
    expect(result).toEqual({
      issuer: ISSUER_A, subject: SUB, subjectAddress: HOLDER_LOWER, expiresAt: new Date((NOW_S - 1000 + 365 * DAY) * 1000),
      credentialId: "urn:uuid:11111111-1111-4111-8111-111111111111", profile: PROFILE, profileVersion: 1, vct: VCT,
      claims: { email: "alice@example.com", emailDomain: "example.com" },
    });
    expect(registryKey(result.subject)).toBe(result.subjectAddress);
  });
  test("selective disclosure: only the chosen claims are returned", async () => {
    const h = harness();
    const { presentation } = h.present({ disclosures: [["emailDomain", "example.com"]] });
    expect((await verifyHeldPresentation(presentation, h.options)).claims).toEqual({ emailDomain: "example.com" });
  });
  test("a lowercase sub and a case-only SIWE address difference pass", async () => {
    await expectCode("ok", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:1:${HOLDER_LOWER}` }) }, { address: HOLDER_LOWER });
  });
});

describe("issuer selection (R1, lookup, cross-org)", () => {
  test("wrong issuer: not in the set", () => expectCode("unknown-issuer", { kid: "did:web:other.credentials.org#k", iss: "did:web:other.credentials.org" }, undefined, { acceptedIssuers: [{ issuerDid: "did:web:other.credentials.org" }] }));
  test("unknown kid", () => expectCode("unknown-issuer", { kid: `${ISSUER_A}#nope` }));
  test("issuer not in acceptedIssuers", () => expectCode("issuer-not-accepted", {}, undefined, { acceptedIssuers: [{ issuerDid: ISSUER_B }] }, [entryA(), entryB()]));
  test("empty acceptedIssuers is refused", () => expectCode("bad-config", {}, undefined, { acceptedIssuers: [] }));
  test("cross-org: org B's credential cannot satisfy org A's policy", () => expectCode("issuer-not-accepted", { seed: SEED_B, kid: KID_B, iss: ISSUER_B }, undefined, { acceptedIssuers: [{ issuerDid: ISSUER_A }] }, [entryA(), entryB()]));
  test("the same credential passes when the policy accepts org B", () => expectCode("ok", { seed: SEED_B, kid: KID_B, iss: ISSUER_B }, undefined, { acceptedIssuers: [{ issuerDid: ISSUER_B }] }, [entryA(), entryB()]));
  test("a kid pinned by the policy but a different kid presented", () => expectCode("issuer-not-accepted", { kid: `${ISSUER_A}#issuing-2` }, undefined, { acceptedIssuers: [{ issuerDid: ISSUER_A, kid: KID_A }] }, [entryA(), entryA({ kid: `${ISSUER_A}#issuing-2` })]));
  test("a credential signed by the wrong key under a listed kid", () => expectCode("bad-signature", { seed: SEED_B }));
  test("iss different from the kid's DID is refused after the signature", () => expectCode("bad-payload", { payload: (p) => ({ ...p, iss: ISSUER_B }) }));
  test("a forged payload gets the same error as any bad signature (no payload oracle)", async () => {
    const h = harness();
    const { presentation } = h.present();
    const [header, , sig] = presentation.sdJwt.split("~")[0]!.split(".");
    const forged = `${header}.${enc({ iss: "did:web:evil.example", profile: "nope", iat: 1 })}.${sig}`;
    const sdJwt = `${forged}~${presentation.sdJwt.split("~").slice(1).join("~")}`;
    expect(await code(verifyHeldPresentation({ ...presentation, sdJwt }, h.options))).toBe("bad-signature");
  });
  test("a tampered iat is refused at the signature", async () => {
    const h = harness();
    const { presentation } = h.present();
    const [header, , sig] = presentation.sdJwt.split("~")[0]!.split(".");
    const p = makeCredential().payload; p.iat = (p.iat as number) - 5;
    const sdJwt = `${header}.${enc(p)}.${sig}~${presentation.sdJwt.split("~").slice(1).join("~")}`;
    expect(await code(verifyHeldPresentation({ ...presentation, sdJwt }, h.options))).toBe("bad-signature");
  });
  test("entry window is checked from now before the signature", async () => {
    const h = harness({}, [entryA({ notAfter: "2026-10-10T00:00:00Z" })]);
    const { presentation } = h.present({ signature: () => new Uint8Array(64) });
    expect(await code(verifyHeldPresentation(presentation, h.options))).toBe("issuer-stopped");
  });
  test("unlisted DID method: refused with no lookup", async () => {
    let lookups = 0;
    const real = harness();
    const spy = { version: 1, resolveIssuer: () => { lookups += 1; return undefined; } };
    const { presentation } = real.present({ kid: "did:ethr:0xabc#k", iss: "did:ethr:0xabc" });
    expect(await code(verifyHeldPresentation(presentation, { ...real.options, issuerSet: spy, acceptedIssuers: [{ issuerDid: "did:ethr:0xabc" }] }))).toBe("did-method-not-allowed");
    expect(lookups).toBe(0);
  });
  test("did:key as an issuer is refused unless the caller enabled it", () => {
    const key = { ...entryA(), issuerDid: "did:key:z6MkTest", kid: "did:key:z6MkTest#z6MkTest" };
    expect(() => parseIssuerSet(setOf(key), { didMethods: METHODS })).toThrow(/did-method-not-allowed/);
    expect(() => parseIssuerSet(setOf(key), { didMethods: { issuer: ["web", "key"] } })).not.toThrow();
  });
});

describe("issuer set validity", () => {
  const bad = (set: unknown) => expect(() => parseIssuerSet(set, { didMethods: METHODS })).toThrow(HeldCredentialError);
  test("duplicate kid, including under different issuerDids", () => {
    bad(setOf(entryA(), entryA()));
    bad(setOf(entryA(), entryA({ issuerDid: ISSUER_B })));
  });
  test("kid not issuerDid#fragment", () => { bad(setOf(entryA({ kid: "did:web:issuer.credentials.org" }))); bad(setOf(entryA({ kid: `${ISSUER_B}#x` }))); bad(setOf(entryA({ kid: `${ISSUER_A}#` }))); });
  test("non-EdDSA entry", () => bad(setOf(entryA({ alg: "ES256K" }))));
  test("null notBefore, bad or non-Z times", () => { bad(setOf(entryA({ notBefore: null }))); bad(setOf(entryA({ notBefore: "2026-10-01" }))); bad(setOf(entryA({ notBefore: "2026-10-01T00:00:00+00:00" }))); bad(setOf(entryA({ notBefore: "2026-02-31T00:00:00Z" }))); });
  test("retiredAt after notAfter", () => bad(setOf(entryA({ retiredAt: "2027-01-01T00:00:00Z", notAfter: "2026-12-01T00:00:00Z" }))));
  test("small-order and non-canonical public keys, wrong length", () => {
    bad(setOf(entryA({ publicKey: encodeBase64Url(Uint8Array.from([1, ...new Array(31).fill(0)])) })));
    bad(setOf(entryA({ publicKey: encodeBase64Url(new Uint8Array(31)) })));
  });
  test("unknown fields, empty vcts, empty set, unknown format", () => { bad(setOf(entryA({ extra: 1 }))); bad(setOf(entryA({ vcts: [] }))); bad(setOf()); bad({ ...setOf(entryA()), format: "x" }); });
  test("resolveIssuer returns the full entry and matches the exact pair only", () => {
    const set = parseIssuerSet(setOf(entryA()), { didMethods: METHODS });
    const entry = set.resolveIssuer(ISSUER_A, KID_A)!;
    expect(Object.keys(entry).sort()).toEqual(["alg", "issuerDid", "kid", "notAfter", "notBefore", "profiles", "publicKey", "retiredAt", "vcts"]);
    expect(set.resolveIssuer(ISSUER_B, KID_A)).toBeUndefined();
  });
});

describe("header and signature", () => {
  test("missing typ, wrong typ, missing kid, wrong alg", async () => {
    await expectCode("bad-header", { header: ({ typ, ...h }) => h });
    await expectCode("bad-header", { header: (h) => ({ ...h, typ: "JWT" }) });
    await expectCode("bad-header", { header: ({ kid, ...h }) => h });
    await expectCode("bad-header", { header: (h) => ({ ...h, alg: "ES256K" }) });
  });
  test("duplicate JSON keys in the header and the payload", async () => {
    const h = harness();
    const { presentation } = h.present();
    const [, payloadB64] = presentation.sdJwt.split("~")[0]!.split(".");
    const dupHeader = enc('{"alg":"EdDSA","typ":"vc+sd-jwt","kid":"' + KID_A + '","kid":"' + KID_A + '"}');
    const sdJwt = `${dupHeader}.${payloadB64}.${encodeBase64Url(new Uint8Array(64))}~`;
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB)) }, h.options))).toBe("bad-header");
    const dupPayload = '{"iss":"x","iss":"y"}';
    const input = `${enc({ alg: "EdDSA", typ: "vc+sd-jwt", kid: KID_A })}.${enc(dupPayload)}`;
    const jwt = `${input}.${encodeBase64Url(ed25519.sign(asciiBytes(input), SEED_A))}`;
    const dupSdJwt = `${jwt}~`;
    expect(await code(verifyHeldPresentation({ sdJwt: dupSdJwt, siwe: makeSiwe(dupSdJwt, h.store.issue(AUDIENCE, SUB)) }, h.options))).toBe("bad-payload");
  });
  test("non-canonical S and a tampered signature", async () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const bump = (sig: Uint8Array) => {
      let s = 0n; for (let i = 31; i >= 0; i -= 1) s = (s << 8n) | BigInt(sig[32 + i]!);
      s += L; const out = sig.slice(); for (let i = 0; i < 32; i += 1) { out[32 + i] = Number(s & 0xffn); s >>= 8n; } return out;
    };
    await expectCode("bad-signature", { signature: bump });
    await expectCode("bad-signature", { signature: (s) => { const o = s.slice(); o[0]! ^= 1; return o; } });
  });
});

describe("credential claims and profile row", () => {
  test("expired and not yet valid", async () => {
    await expectCode("expired", { payload: (p) => ({ ...p, iat: NOW_S - 400 * DAY, nbf: NOW_S - 400 * DAY, exp: NOW_S - 100 }) }, undefined, {}, [entryA({ notBefore: "2025-01-01T00:00:00Z" })]);
    await expectCode("not-yet-valid", { payload: (p) => ({ ...p, iat: NOW_S + 100, nbf: NOW_S + 100, exp: NOW_S + 100 + DAY }) });
  });
  test("missing iat is refused, nbf must equal iat", async () => {
    await expectCode("bad-payload", { payload: ({ iat, ...p }) => p });
    await expectCode("bad-payload", { payload: (p) => ({ ...p, nbf: (p.iat as number) + 1 }) });
  });
  test("exp - iat above the row's lifetime", () => expectCode("bad-lifetime", { payload: (p) => ({ ...p, exp: (p.iat as number) + 365 * DAY + 1 }) }));
  test("wrong profile row: vct, profile, version, binding domain, unlisted pair", async () => {
    await expectCode("profile-mismatch", { payload: (p) => ({ ...p, vct: "other.vct/v1" }) });
    await expectCode("profile-mismatch", { payload: (p) => ({ ...p, profile: "tinycloud.org-membership/v1" }) });
    await expectCode("profile-mismatch", { payload: (p) => ({ ...p, profileVersion: 2 }) });
    await expectCode("bad-holder-binding", { payload: (p) => ({ ...p, holderBinding: { did: SUB, signingDomain: "tinycloud.credentials/holder-binding/v1" } }) });
    await expectCode("profile-mismatch", {}, undefined, {}, [entryA({ vcts: ["something.else/v1"] })]);
    await expectCode("profile-mismatch", {}, undefined, {}, [entryA({ profiles: ["tinycloud.org-membership/v1"] })]);
  });
  test("a row that names a different vct is not satisfied by the issuer's vct", async () => {
    const rows = [{ ...(await import("./rows")).EMAIL_HELD_ROW, vct: "different.vct/v1" }];
    await expectCode("profile-mismatch", {}, undefined, { rows });
  });
  test("acceptedProfiles: empty refused, profile outside it refused, result carries profile/vct", async () => {
    await expectCode("bad-config", {}, undefined, { acceptedProfiles: [] });
    await expectCode("profile-not-accepted", {}, undefined, { acceptedProfiles: [{ profile: "tinycloud.org-membership/v1", profileVersion: 1 }] });
  });
  test("status: missing, non-none, extra members", async () => {
    await expectCode("bad-status", { payload: ({ status, ...p }) => p });
    await expectCode("bad-status", { payload: (p) => ({ ...p, status: { method: "list" } }) });
    await expectCode("bad-status", { payload: (p) => ({ ...p, status: { method: "none", extra: 1 } }) });
  });
  test("missing profile, legacy-shaped record, acquisition ticket", async () => {
    await expectCode("bad-payload", { payload: ({ profile, ...p }) => p });
    await expectCode("bad-header", { header: ({ kid, typ, ...h }) => h });
    await expectCode("bad-subject", { payload: (p) => ({ ...p, sub: "did:key:z6MkTicketHolder", holderBinding: { did: "did:key:z6MkTicketHolder", signingDomain: "tinycloud.credentials/holder-binding/v1" } }) });
    await expectCode("bad-payload", { payload: (p) => ({ ...p, tinycloud_share: {} }) });
  });
  test("subject: another chain, wrong EIP-55 checksum, holderBinding did differing", async () => {
    await expectCode("bad-subject", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:137:${HOLDER}` }) });
    const flipped = HOLDER.replace(/[a-f]/i, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    await expectCode("bad-subject", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:1:${flipped}`, holderBinding: { did: SUB, signingDomain: BINDING } }) });
    await expectCode("bad-holder-binding", { payload: (p) => ({ ...p, holderBinding: { did: `did:pkh:eip155:1:${toChecksumAddress(addressOf(otherKey))}`, signingDomain: BINDING } }) });
  });
  test("principal comparison helpers", () => {
    expect(pkhPrincipalsEqual(SUB, `did:pkh:eip155:1:${HOLDER_LOWER}`)).toBe(true);
    expect(pkhPrincipalsEqual(SUB, `did:pkh:eip155:137:${HOLDER}`)).toBe(false);
    expect(registryKey(SUB)).toBe(HOLDER_LOWER);
    expect(registryKey(`did:pkh:eip155:1:${HOLDER_LOWER}`)).toBe(registryKey(SUB));
  });
});

describe("disclosures", () => {
  test("a digest not in _sd, a repeated digest, a collision, an unlisted path", async () => {
    await expectCode("bad-disclosure", { rawDisclosures: [disclosure("email", "mallory@example.com", "other-salt").text] });
    const dup = disclosure("email", "alice@example.com", "salt-email").text;
    await expectCode("bad-disclosure", { rawDisclosures: [dup] });
    await expectCode("bad-disclosure", { disclosures: [["sub", "did:pkh:eip155:1:0x0000000000000000000000000000000000000000"]] });
    await expectCode("bad-disclosure", { disclosures: [["phone", "123"]] });
  });
  test("array-element and nested _sd disclosures, non-string values", async () => {
    await expectCode("bad-disclosure", { disclosures: [["email", { _sd: ["x"] }]] });
    await expectCode("bad-disclosure", { disclosures: [["email", ["a"]]] });
    const arrayElement = enc(JSON.stringify(["salt", "alice@example.com"]));
    await expectCode("bad-disclosure", { rawDisclosures: [arrayElement], payload: (p) => ({ ...p, _sd: [...(p._sd as string[]), encodeBase64Url(sha256(asciiBytes(arrayElement)))] }) });
  });
  test("non-canonical email value and a mismatched emailDomain", async () => {
    await expectCode("bad-disclosure", { disclosures: [["email", "Alice@Example.com"]] });
    await expectCode("bad-disclosure", { disclosures: [["email", "alice@example.com"], ["emailDomain", "other.com"]] });
  });
});

describe("SIWE presentation proof (R4-R8)", () => {
  test("signed by someone else, and a different address", async () => {
    await expectCode("bad-siwe-signature", {}, { signer: otherKey });
    await expectCode("bad-siwe", {}, { address: toChecksumAddress(addressOf(otherKey)) });
    await expectCode("bad-siwe", {}, { chainId: "137" });
  });
  test("audience: domain, uri, version, userinfo, uppercase host, default port, recap, second resource", async () => {
    await expectCode("bad-siwe", {}, { domain: "exo.tinycloud.xyz" });
    await expectCode("bad-siwe", {}, { uri: "https://exo.tinycloud.xyz" });
    await expectCode("bad-siwe", {}, { uri: `http://${AUDIENCE}` });
    await expectCode("bad-siwe", {}, { uri: `https://user@${AUDIENCE}` });
    await expectCode("bad-siwe", {}, { version: "2" });
    await expectCode("bad-siwe", {}, { statement: "Sign in" });
    await expectCode("bad-config", {}, undefined, { audience: "Billing.tinycloud.xyz" });
    await expectCode("bad-config", {}, undefined, { audience: "billing.tinycloud.xyz:443" });
    await expectCode("bad-config", {}, undefined, { audience: "https://billing.tinycloud.xyz" });
    const sdHash = (j: string) => `urn:tinycloud:sd-hash:${encodeBase64Url(sha256(asciiBytes(j)))}`;
    const h = harness(); const { sdJwt } = makeCredential(); const nonce = h.store.issue(AUDIENCE, SUB);
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB), { resources: [sdHash(sdJwt), "urn:recap:eyJhdHQiOnt9fQ"] }) }, h.options))).toBe("bad-siwe");
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB), { resources: [] }) }, h.options))).toBe("bad-siwe");
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB), { resources: ["urn:recap:eyJhdHQiOnt9fQ"] }) }, h.options))).toBe("bad-siwe");
  });
  test("a nonce minted for another audience cannot be used here", async () => {
    const h = harness(); const { sdJwt } = makeCredential(); const foreign = h.store.issue("exo.tinycloud.xyz", SUB);
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, foreign) }, h.options))).toBe("nonce-replayed");
  });
  test("SIWE time fields are enforced when present and optional when absent", async () => {
    await expectCode("bad-siwe", {}, { expirationTime: "2026-10-19T00:00:00.000Z" });
    await expectCode("bad-siwe", {}, { notBefore: "2026-10-21T00:00:00.000Z" });
    await expectCode("ok", {}, { expirationTime: "2026-10-21T00:00:00.000Z", notBefore: "2026-10-19T00:00:00.000Z" });
  });
  test("nonce format: base64url characters and too-short nonces", async () => {
    for (const nonce of ["abc_def-ghijklmnopqrstuvwxyz0123", "abcdefghij"]) {
      const h = harness(); const { sdJwt } = makeCredential();
      expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, nonce) }, h.options))).toMatch(/bad-nonce|bad-siwe/);
    }
  });
  test("sd_hash: no trailing ~, padding, a different disclosure set, a KB-JWT suffix", async () => {
    const h = harness(); const nonce = h.store.issue(AUDIENCE, SUB); const { sdJwt } = makeCredential();
    const other = makeCredential({ disclosures: [["emailDomain", "example.com"]] }).sdJwt;
    const wrongHashes = [sdJwt.slice(0, -1), sdJwt + "=", other];
    for (const variant of wrongHashes) {
      const hash = encodeBase64Url(sha256(asciiBytes(variant)));
      const siwe = makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB), { resources: [`urn:tinycloud:sd-hash:${hash}`] });
      expect(await code(verifyHeldPresentation({ sdJwt, siwe }, h.options))).toBe("bad-siwe");
    }
    const withKb = `${sdJwt}${enc({ alg: "ES256K" })}.${enc({})}.${enc("sig")}`;
    expect(await code(verifyHeldPresentation({ sdJwt: withKb, siwe: makeSiwe(withKb, nonce) }, h.options))).toBe("bad-presentation");
  });
});

describe("nonce store (R3, R4)", () => {
  test("replayed and unknown nonces", async () => {
    const h = harness(); const { presentation } = h.present();
    expect(await code(verifyHeldPresentation(presentation, h.options))).toBe("ok");
    expect(await code(verifyHeldPresentation(presentation, h.options))).toBe("nonce-replayed");
    const unknown = harness(); const cred = makeCredential();
    expect(await code(verifyHeldPresentation({ sdJwt: cred.sdJwt, siwe: makeSiwe(cred.sdJwt, "0123456789abcdef0123456789abcdef") }, unknown.options))).toBe("nonce-replayed");
  });
  test("two concurrent presentations of one nonce: exactly one succeeds", async () => {
    const h = harness(); const { presentation } = h.present();
    const results = await Promise.all([code(verifyHeldPresentation(presentation, h.options)), code(verifyHeldPresentation(presentation, h.options))]);
    expect(results.sort()).toEqual(["nonce-replayed", "ok"]);
  });
  test("a refused presentation HAS spent its nonce (consume-first)", async () => {
    const refusals: [string, CredentialSpec][] = [
      ["bad-signature", { signature: () => new Uint8Array(64) }],
      ["unknown-issuer", { kid: `${ISSUER_A}#nope` }],
      ["expired", { payload: (p) => ({ ...p, exp: NOW_S - 10 }) }],
      ["bad-subject", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:137:${HOLDER}` }) }],
    ];
    for (const [expected, spec] of refusals) {
      const h = harness(); const nonce = h.store.issue(AUDIENCE, SUB);
      const bad = makeCredential(spec).sdJwt; const good = makeCredential().sdJwt;
      expect(await code(verifyHeldPresentation({ sdJwt: bad, siwe: makeSiwe(bad, nonce) }, h.options))).toBe(expected);
      expect(await code(verifyHeldPresentation({ sdJwt: good, siwe: makeSiwe(good, nonce) }, h.options))).toBe("nonce-replayed");
    }
  });
  test("a syntactically broken presentation spends nothing before the SIWE parse", async () => {
    const h = harness(); const nonce = h.store.issue(AUDIENCE, SUB); const { sdJwt } = makeCredential();
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: { message: "not a siwe", signature: "0x00" } }, h.options))).toBe("bad-siwe");
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, nonce) }, h.options))).toBe("ok");
  });
  test("caller B cannot spend or burn a nonce bound to caller A", async () => {
    const h = harness(); const nonce = h.store.issue(AUDIENCE, SUB); const { sdJwt } = makeCredential();
    const callerB = `did:pkh:eip155:1:${toChecksumAddress(addressOf(otherKey))}`;
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, nonce) }, { ...h.options, callerAccount: callerB }))).toBe("nonce-replayed");
    expect(await code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, nonce) }, h.options))).toBe("ok"); // A's nonce is intact
  });
  test("caller A's own refusal spends A's nonce; subject other than the caller is refused", async () => {
    const h = harness(); const other = `did:pkh:eip155:1:${toChecksumAddress(addressOf(otherKey))}`;
    const { presentation, nonce } = h.present(undefined, undefined, other);
    expect(await code(verifyHeldPresentation(presentation, { ...h.options, callerAccount: other }))).toBe("nonce-account-mismatch");
    expect((await h.store.consume(AUDIENCE, nonce, other)).existed).toBe(false);
  });
  test("an unbound nonce cannot be issued, and callerAccount is required", async () => {
    expect(() => new InMemoryNonceStore().issue(AUDIENCE, "" as string)).toThrow(TypeError);
    const h = harness(); const { presentation } = h.present();
    expect(await code(verifyHeldPresentation(presentation, { ...h.options, callerAccount: "" }))).toBe("bad-config");
  });
  test("a nonce bound to the subject's own account passes (principal compare)", async () => {
    const h = harness({ callerAccount: `did:pkh:eip155:1:${HOLDER_LOWER}` }); const { presentation } = h.present();
    expect(await code(verifyHeldPresentation(presentation, h.options))).toBe("ok");
  });
  test("the store interface has exactly one checking operation", () => {
    const store: NonceStore = new InMemoryNonceStore();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((n) => n !== "constructor" && n !== "issue")).toEqual(["consume"]);
  });
});

describe("retiredAt and notAfter", () => {
  const RETIRED = "2026-10-10T00:00:00Z";
  const retiredMs = Date.parse(RETIRED) / 1000;
  test("iat before retiredAt still verifies after retiredAt", () => expectCode("ok", { payload: (p) => ({ ...p, iat: retiredMs - 100, nbf: retiredMs - 100, exp: retiredMs - 100 + 365 * DAY }) }, undefined, {}, [entryA({ retiredAt: RETIRED })]));
  test("iat at or after retiredAt is refused", async () => {
    await expectCode("issuer-retired", { payload: (p) => ({ ...p, iat: retiredMs, nbf: retiredMs, exp: retiredMs + DAY }) }, undefined, {}, [entryA({ retiredAt: RETIRED })]);
    await expectCode("issuer-retired", { payload: (p) => ({ ...p, iat: retiredMs + 5, nbf: retiredMs + 5, exp: retiredMs + 5 + DAY }) }, undefined, {}, [entryA({ retiredAt: RETIRED })]);
  });
  test("now >= notAfter is refused regardless of iat", async () => {
    await expectCode("issuer-stopped", {}, undefined, {}, [entryA({ notAfter: "2026-10-20T00:00:00Z" })]);
    await expectCode("issuer-stopped", { payload: (p) => ({ ...p, iat: NOW_S - 3600, nbf: NOW_S - 3600 }) }, undefined, {}, [entryA({ notAfter: "2026-10-19T00:00:00Z" })]);
  });
  test("iat before the entry's notBefore is refused", () => expectCode("issuer-not-yet-valid", { payload: (p) => ({ ...p, iat: NOW_S - 30 * DAY, nbf: NOW_S - 30 * DAY, exp: NOW_S + DAY }) }));
  test("rotation: notAfter = retiredAt + max lifetime stops a back-dated credential", async () => {
    const entry = entryA({ retiredAt: RETIRED, notAfter: new Date(Date.parse(RETIRED) + 365 * DAY * 1000).toISOString().replace(".000", "") });
    const late = new Date((Date.parse(RETIRED) / 1000 + 366 * DAY) * 1000);
    const backdated = { payload: (p: Obj) => ({ ...p, iat: retiredMs - 10, nbf: retiredMs - 10, exp: retiredMs - 10 + 365 * DAY }) };
    await expectCode("issuer-stopped", backdated, undefined, { now: late }, [entry]);
  });
});

describe("normaliseEmail (alias rules confirmed by Sam 2026-10-19, same as billing)", () => {
  test("folds +tag, strips gmail dots, maps googlemail, rejects malformed", () => {
    expect(normaliseEmail("  A.B+x@Gmail.com ")).toBe("ab@gmail.com");
    expect(normaliseEmail("a.b+x@googlemail.com")).toBe("ab@gmail.com");
    expect(normaliseEmail("a.b+x@example.com")).toBe("a.b@example.com");
    for (const bad of ["", "   ", "a b@x.com", "a@@x.com", "a@x", "+x@gmail.com", "a@.com", "a@x..com"]) expect(normaliseEmail(bad)).toBeNull();
  });
  test("refuses any non-ASCII input before trim/lowercase (G14 open)", () => {
    for (const bad of ["jos\u00e9@example.com", "a@b\u00fccher.de", "\u0430lice@example.com", "alice@\u0435xample.com", " a@x.com\u00a0", "A@X.COM\u0130"]) expect(normaliseEmail(bad)).toBeNull();
  });
  test("a punycode-looking ASCII address is still accepted", () => {
    expect(normaliseEmail("Alice@xn--bcher-kva.example")).toBe("alice@xn--bcher-kva.example");
  });
  test("validateDisclosed refuses non-ASCII email and emailDomain, accepts ASCII punycode", () => {
    const row = EMAIL_HELD_ROW;
    expect(() => row.validateDisclosed({ email: "\u0430lice@example.com" })).toThrow(HeldCredentialError);
    expect(() => row.validateDisclosed({ emailDomain: "b\u00fccher.de" })).toThrow(HeldCredentialError);
    expect(() => row.validateDisclosed({ email: "a@xn--bcher-kva.example", emailDomain: "xn--bcher-kva.example" })).not.toThrow();
  });
});

test("the module has no Node-only imports (Worker-safe)", async () => {
  for (const file of ["crypto", "did", "email", "encoding", "errors", "issuer-set", "nonce-store", "rows", "siwe", "verify", "index"]) {
    const text = await Bun.file(new URL(`./${file}.ts`, import.meta.url)).text();
    expect(text).not.toMatch(/from "node:|require\(|Buffer\b|from "crypto"|process\./);
  }
});

describe("TC-1540 N1: jti", () => {
  test("jti must be a lowercase urn:uuid v4", async () => {
    const ok = "urn:uuid:11111111-1111-4111-8111-111111111111";
    await expectCode("ok", { payload: (p) => ({ ...p, jti: ok }) });
    for (const jti of [
      "11111111-1111-4111-8111-111111111111", "urn:uuid:11111111-1111-1111-8111-111111111111", "urn:uuid:11111111-1111-5111-8111-111111111111",
      "urn:uuid:11111111-1111-4111-c111-111111111111", "urn:uuid:11111111-1111-4111-7111-111111111111", "urn:uuid:AAAAAAAA-1111-4111-8111-111111111111",
      "urn:uuid:11111111-1111-4111-8111-11111111111", "urn:uuid:11111111-1111-4111-8111-1111111111111", `${ok} `, "x", "",
    ]) {
      await expectCode("bad-payload", { payload: (p) => ({ ...p, jti }) });
    }
    for (const jti of [7, null, [ok]]) await expectCode("bad-payload", { payload: (p) => ({ ...p, jti }) });
    for (const variant of ["8", "9", "a", "b"]) await expectCode("ok", { payload: (p) => ({ ...p, jti: `urn:uuid:11111111-1111-4111-${variant}111-111111111111` }) });
  });
});
