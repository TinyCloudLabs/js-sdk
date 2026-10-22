import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import * as ts from "typescript";
import {
  HeldCredentialError,
  InMemoryNonceStore,
  IssuerSet,
  ORG_MEMBERSHIP_ROWS,
  PRESENTATION_STATEMENT,
  assertValidAudience,
  normaliseEmail,
  parseIssuerSet,
  pkhPrincipalsEqual,
  registryKey,
  toChecksumAddress,
  verifyHeldPresentation,
  type AcceptedIssuer,
  type AcceptedProfile,
  type NonceStore,
  type ProfileRow,
  type VerifyHeldPresentationOptions,
} from "./index";
import { MAX_JSON_DEPTH, decodeBase64Url, decodeUtf8, asciiBytes, bytesToHex, encodeBase64Url, parseStrictJson } from "./encoding";
import { HELD_LIMITS } from "./verify";
import { verifyEd25519Strict } from "./crypto";
import { parseRfc3339 } from "./siwe";
import { DEFAULT_ROWS, EMAIL_HELD_ROW, ORG_MEMBERSHIP_FREE_ROW, ORG_MEMBERSHIP_ROW, SHIPPED_ROWS, rowPermitsIssuer } from "./rows";
import { selectDisclosures, sdHash, verifyHeldEmailCredential, type HeldEmailCredentialOptions } from "./credential";

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
  test("a lowercase sub passes against the checksummed SIWE address (the SIWE address itself must be EIP-55, TC-1540)", async () => {
    await expectCode("ok", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:1:${HOLDER_LOWER}` }) }, { address: HOLDER });
  });
});

describe("issuer selection (R1, lookup, cross-org)", () => {
  test("wrong issuer: not in the set", () => expectCode("unknown-issuer", { kid: "did:web:other.credentials.org#k", iss: "did:web:other.credentials.org" }, undefined, { acceptedIssuers: [{ issuerDid: "did:web:other.credentials.org" }] }));
  test("unknown kid", () => expectCode("unknown-issuer", { kid: `${ISSUER_A}#nope` }));
  test("issuer not in acceptedIssuers", () => expectCode("issuer-not-accepted", {}, undefined, { acceptedIssuers: [{ issuerDid: ISSUER_B }] }));
  test("empty acceptedIssuers is refused", () => expectCode("bad-config", {}, undefined, { acceptedIssuers: [] }));
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
  test("unlisted DID method is refused before any issuer lookup", async () => {
    const real = harness();
    const { presentation } = real.present({ kid: "did:ethr:0xabc#k", iss: "did:ethr:0xabc" });
    expect(await code(verifyHeldPresentation(presentation, { ...real.options, acceptedIssuers: [{ issuerDid: "did:ethr:0xabc" }] }))).toBe("did-method-not-allowed");
  });
  test("did:key as an issuer is refused unless the caller enabled it", () => {
    const key = { ...entryA(), issuerDid: "did:key:z6MkTest", kid: "did:key:z6MkTest#z6MkTest", profiles: ["tinycloud.did-key-fixture/v1"] };
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
    expect(loadCode([entryA({ profiles: ["tinycloud.org-membership/v1"] })])).toBe("bad-issuer-set");
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

const FORBIDDEN_NODE_ACCESS = /from "node:|require\(|Buffer\b|from "crypto"|process\./;

/** Removes comments by parser position; string, template and regex contents are kept, so only comment text is blanked. */
function stripComments(source: string): string {
  const sf = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, number>();
  const collect = (found: readonly ts.CommentRange[] | undefined) => {
    for (const r of found ?? []) ranges.set(r.pos, r.end);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  let out = source;
  for (const [pos, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, " ") + out.slice(end);
  }
  return out;
}

test("the module has no Node-only imports (Worker-safe)", async () => {
  for (const file of ["credential", "crypto", "did", "email", "encoding", "errors", "issuer-set", "nonce-store", "rows", "siwe", "verify", "index"]) {
    const text = await Bun.file(new URL(`./${file}.ts`, import.meta.url)).text();
    expect(stripComments(text)).not.toMatch(FORBIDDEN_NODE_ACCESS);
  }
});

describe("Worker-safety scan (stripComments + FORBIDDEN_NODE_ACCESS)", () => {
  const flagged = (source: string) => FORBIDDEN_NODE_ACCESS.test(stripComments(source));

  test("flags executable Node access, including after literals that contain comment markers", () => {
    expect(flagged("process.env.NODE_ENV;\n")).toBe(true);
    expect(flagged(`const probeUrl = "https://example.invalid"; process.env.NODE_ENV;\n`)).toBe(true);
    expect(flagged(`const beginMarker = "/*"; process.env.NODE_ENV; const endMarker = "*/";\n`)).toBe(true);
    expect(flagged(`const q = /"/; process.env.A;\n`)).toBe(true);
  });

  test("ignores line and block comments that mention Node access", () => {
    expect(flagged("// uses process.env here\nconst a = 1;\n")).toBe(false);
    expect(flagged("/**\n * process.x in docs\n */\nconst a = 1;\n")).toBe(false);
    expect(flagged("const a = 1; // process.z\nexport const b = a;\n")).toBe(false);
  });

  test("still flags Node access written as string or template data", () => {
    expect(flagged("const t = `process.data`;\n")).toBe(true);
    expect(flagged(`const s = "process.data";\n`)).toBe(true);
  });
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

describe("TC-1540 N2: header members and descriptorDigest", () => {
  test("crit and any unknown header member are refused; only alg, typ and kid are allowed", async () => {
    for (const extra of [{ crit: ["exp"] }, { crit: [] }, { jku: "https://x" }, { jwk: {} }, { x5u: "https://x" }, { cty: "x" }, { zip: "DEF" }, { b64: false }, { foo: 1 }]) {
      await expectCode("bad-header", { header: (h) => ({ ...h, ...extra }) });
    }
    await expectCode("ok", { header: (h) => ({ kid: h.kid, typ: h.typ, alg: h.alg }) });
  });
  test("descriptorDigest is not a signed claim of the email row (spec 3.2 does not list it)", async () => {
    expect(EMAIL_HELD_ROW.optionalSignedClaims).toEqual([]);
    await expectCode("bad-payload", { payload: (p) => ({ ...p, descriptorDigest: "sha256:abc" }) });
  });
});

/** Presents a hand-built `sdJwt` with a SIWE that signs it, so the refusal under test is the only fault. */
async function presentRaw(h: Harness, sdJwt: string) {
  return code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, h.store.issue(AUDIENCE, SUB)) }, h.options));
}
const withHeaderSegment = (segment: string) => {
  const [, payloadB64, sig] = makeCredential().jwt.split(".");
  return `${segment}.${payloadB64}.${sig}~`;
};

describe("TC-1540 N3: bounded parsing", () => {
  test("a 200k '[' and a 200k '{' header are refused with the verifier's code, before any signature work", async () => {
    const h = harness();
    for (const open of ["[", '{"a":']) {
      expect(await presentRaw(h, withHeaderSegment(enc(open.repeat(200_000))))).toBe("bad-presentation");
    }
  });
  test("a header inside the size limits but deeply nested is refused by the depth cap, not a RangeError", async () => {
    const h = harness();
    for (const text of ["[".repeat(700), '{"a":'.repeat(150)]) {
      expect(await presentRaw(h, withHeaderSegment(enc(text)))).toBe("bad-header");
    }
  });
  test("parseStrictJson is depth-capped with the caller's code, and the cap is exact", () => {
    const thrown = (text: string) => { try { parseStrictJson(text, "bad-payload"); return "ok"; } catch (e) { return e instanceof HeldCredentialError ? e.code : `escaped ${(e as Error).name}`; } };
    for (const open of ["[", '{"a":']) {
      const close = open === "[" ? "]" : "}";
      const nest = (n: number) => open.repeat(n) + "1" + close.repeat(n);
      expect(thrown(nest(MAX_JSON_DEPTH))).toBe("ok");
      expect(thrown(nest(MAX_JSON_DEPTH + 1))).toBe("bad-payload");
      expect(thrown(open.repeat(200_000))).toBe("bad-payload");
    }
  });
  test("oversized sdJwt, siwe message and siwe signature are refused", async () => {
    const h = harness();
    const good = makeCredential().sdJwt;
    expect(await code(verifyHeldPresentation({ sdJwt: "a".repeat(HELD_LIMITS.sdJwtChars + 1), siwe: makeSiwe(good, h.store.issue(AUDIENCE, SUB)) }, h.options))).toBe("bad-presentation");
    const siwe = makeSiwe(good, h.store.issue(AUDIENCE, SUB));
    expect(await code(verifyHeldPresentation({ sdJwt: good, siwe: { ...siwe, message: siwe.message + "x".repeat(HELD_LIMITS.siweMessageChars) } }, h.options))).toBe("bad-presentation");
    expect(await code(verifyHeldPresentation({ sdJwt: good, siwe: { ...siwe, signature: siwe.signature + "00" } }, h.options))).toBe("bad-presentation");
  });
  test("a near-limit valid credential still verifies (319-char email)", async () => {
    const email = `${"a".repeat(307)}@example.com`;
    expect(email.length).toBe(319);
    const h = harness();
    const { presentation } = h.present({ disclosures: [["email", email], ["emailDomain", "example.com"]] });
    expect(presentation.sdJwt.length).toBeLessThan(HELD_LIMITS.sdJwtChars);
    expect((await verifyHeldPresentation(presentation, h.options)).claims.email).toBe(email);
  });
  test("duplicate keys in a disclosure are refused; __proto__ keys are inert", async () => {
    const h = harness();
    const dup = enc('["s","email","a@example.com","x"]');
    const digest = encodeBase64Url(sha256(asciiBytes(dup)));
    const cred = makeCredential({ disclosures: [], rawDisclosures: [dup], payload: (p) => ({ ...p, _sd: [digest] }) });
    expect(await presentRaw(h, cred.sdJwt)).toBe("bad-disclosure");
    expect(() => parseStrictJson('{"a":1,"a":2}', "bad-payload")).toThrow(HeldCredentialError);
    expect(() => parseStrictJson('{"__proto__":1,"__proto__":2}', "bad-payload")).toThrow(HeldCredentialError);
    const parsed = parseStrictJson('{"__proto__":{"polluted":true}}', "bad-payload") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expectCode("bad-header", { header: (hd) => JSON.parse(`{"__proto__":{"alg":"x"},"alg":"EdDSA","typ":"${hd.typ}","kid":"${hd.kid}"}`) });
    await expectCode("bad-payload", { payload: (p) => JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(p).slice(1)}`) });
  });
});

describe("TC-1540 Miller 1: per-segment byte limits", () => {
  test("a 3.5 MB header is refused by the verifier's code (total cap) and an oversized header segment under the total cap too", async () => {
    const h = harness();
    expect(await presentRaw(h, withHeaderSegment("a".repeat(3_500_000)))).toBe("bad-presentation");
    const [header, payload, sig] = makeCredential().jwt.split(".");
    expect(await presentRaw(h, `${"a".repeat(HELD_LIMITS.headerSegmentChars + 1)}.${payload}.${sig}~`)).toBe("bad-presentation");
    expect(await presentRaw(h, `${header}.${"a".repeat(HELD_LIMITS.payloadSegmentChars + 1)}.${sig}~`)).toBe("bad-presentation");
    expect(await presentRaw(h, `${header}.${payload}.${"a".repeat(HELD_LIMITS.signatureSegmentChars + 1)}~`)).toBe("bad-presentation");
  });
  test("too many or oversized disclosures are refused before they are decoded", async () => {
    const h = harness();
    expect(await presentRaw(h, makeCredential({ rawDisclosures: Array.from({ length: HELD_LIMITS.disclosures }, (_, i) => enc(`d${i}`)) }).sdJwt)).toBe("bad-presentation");
    expect(await presentRaw(h, makeCredential({ rawDisclosures: ["a".repeat(HELD_LIMITS.disclosureChars + 1)] }).sdJwt)).toBe("bad-presentation");
  });
  test("segments at exactly the limit are not refused for size", async () => {
    const h = harness();
    const [, payload, sig] = makeCredential().jwt.split(".");
    // exactly at the cap: refused later (bad signature/header content), not for size
    expect(await presentRaw(h, `${"a".repeat(HELD_LIMITS.headerSegmentChars)}.${payload}.${sig}~`)).not.toBe("bad-presentation");
  });
});

describe("TC-1540 Miller 2: duplicate _sd digests", () => {
  test("a repeated digest in _sd is refused even when the disclosure is genuine", async () => {
    await expectCode("bad-payload", { payload: (p) => ({ ...p, _sd: [...(p._sd as string[]), (p._sd as string[])[0]] }) });
    await expectCode("bad-payload", { payload: (p) => ({ ...p, _sd: [...(p._sd as string[]), ...(p._sd as string[])] }) });
    await expectCode("ok", {});
  });
});

describe("TC-1540 Miller 3: strict UTF-8", () => {
  const bytes = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
  const b64 = (u: Uint8Array) => encodeBase64Url(u);
  test("decodeUtf8 refuses invalid bytes and keeps a BOM", () => {
    expect(() => decodeUtf8(Uint8Array.from([0xff]), "bad-payload")).toThrow(HeldCredentialError);
    expect(() => decodeUtf8(Uint8Array.from([0xc0, 0x80]), "bad-payload")).toThrow(HeldCredentialError);
    expect(decodeUtf8(bytes([0xef, 0xbb, 0xbf], "{}"), "bad-payload").charCodeAt(0)).toBe(0xfeff);
  });
  test("a BOM before the header JSON is refused", async () => {
    const h = harness();
    const header = b64(bytes([0xef, 0xbb, 0xbf], JSON.stringify({ alg: "EdDSA", typ: "vc+sd-jwt", kid: KID_A })));
    expect(await presentRaw(h, withHeaderSegment(header))).toBe("bad-header");
  });
  test("invalid UTF-8 in a signed payload string is refused, not replaced", async () => {
    const h = harness();
    const payload = b64(bytes('{"iss":"', [0xff], '"}'));
    const input = `${enc({ alg: "EdDSA", typ: "vc+sd-jwt", kid: KID_A })}.${payload}`;
    const sdJwt = `${input}.${encodeBase64Url(ed25519.sign(asciiBytes(input), SEED_A))}~`;
    expect(await presentRaw(h, sdJwt)).toBe("bad-payload");
  });
  test("invalid UTF-8 and a BOM in a genuine disclosure are refused", async () => {
    for (const raw of [bytes('["s","email","', [0xff], '"]'), bytes([0xef, 0xbb, 0xbf], '["s","email","a@example.com"]')]) {
      const text = b64(raw);
      const digest = encodeBase64Url(sha256(asciiBytes(text)));
      const cred = makeCredential({ disclosures: [], rawDisclosures: [text], payload: (p) => ({ ...p, _sd: [digest] }) });
      expect(await presentRaw(harness(), cred.sdJwt)).toBe("bad-disclosure");
    }
  });
});

describe("TC-1540 Miller 4: integers only", () => {
  const signedRaw = async (rewrite: (json: string) => string) => {
    const h = harness();
    const input = `${enc({ alg: "EdDSA", typ: "vc+sd-jwt", kid: KID_A })}.${enc(rewrite(JSON.stringify(makeCredential().payload)))}`;
    return presentRaw(h, `${input}.${encodeBase64Url(ed25519.sign(asciiBytes(input), SEED_A))}~${makeCredential().sdJwt.split("~").slice(1).join("~")}`);
  };
  test("1.0, 1e3 and -0 are refused as numbers; plain integers still verify", async () => {
    const iat = (makeCredential().payload.iat as number);
    expect(await signedRaw((j) => j.replace(`"iat":${iat}`, `"iat":${iat}.0`))).toBe("bad-payload");
    expect(await signedRaw((j) => j.replace(/"exp":(\d+)/, (_, n) => `"exp":${n}.0`))).toBe("bad-payload");
    expect(await signedRaw((j) => j.replace(/"nbf":(\d+)/, (_, n) => `"nbf":${n}e0`))).toBe("bad-payload");
    expect(await signedRaw((j) => j.replace('"profileVersion":1', '"profileVersion":-0'))).toBe("bad-payload");
    expect(await signedRaw((j) => j)).toBe("ok");
  });
  test("parseStrictJson number forms", () => {
    for (const bad of ["1.0", "1e3", "1E3", "1.5", "-0", "01", "-", "1.", "[1.0]"]) expect(() => parseStrictJson(bad, "bad-payload")).toThrow(HeldCredentialError);
    for (const good of ["0", "-1", "123456789", "[0,1,-2]"]) expect(() => parseStrictJson(good, "bad-payload")).not.toThrow();
  });
});

describe("TC-1540 Miller 5: strict Ed25519 (cofactorless, mixed-order R refused)", () => {
  const L = ed25519.CURVE.n;
  const le = (n: bigint, len: number) => { const out = new Uint8Array(len); for (let i = 0; i < len; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
  const leNum = (b: Uint8Array) => b.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const Point = ed25519.ExtendedPoint;
  // an order-8 torsion point (y = c7176a70...037a)
  const T = Point.fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a");

  test("the torsion vector is really order 8, and R + T is mixed-order, not small-order", () => {
    expect(T.multiply(8n).is0()).toBe(true);
    expect(T.multiply(4n).is0()).toBe(false);
    expect(T.isSmallOrder()).toBe(true);
  });
  test("a signature whose R carries an order-8 component passes noble's cofactored verify but is refused", () => {
    const seedBytes = seed(7);
    const message = asciiBytes("mixed-order R");
    const { scalar: a, pointBytes: A } = ed25519.utils.getExtendedPublicKey(seedBytes);
    const r = 123456789123456789n;
    const R = Point.BASE.multiply(r).add(T);
    expect(R.isSmallOrder()).toBe(false);
    const Rbytes = R.toRawBytes();
    const k = leNum(sha512(Uint8Array.from([...Rbytes, ...A, ...message]))) % L;
    const S = (r + k * a) % L;
    const signature = Uint8Array.from([...Rbytes, ...le(S, 32)]);
    expect(ed25519.verify(signature, message, A, { zip215: false })).toBe(true); // noble: cofactored, accepts
    expect(verifyEd25519Strict(signature, message, A)).toBe(false);
  });
  test("an honest signature still verifies", () => {
    const message = asciiBytes("honest");
    const pub = ed25519.getPublicKey(SEED_A);
    expect(verifyEd25519Strict(ed25519.sign(message, SEED_A), message, pub)).toBe(true);
  });
  test("a small-order public key and a small-order R are still refused", () => {
    const message = asciiBytes("x");
    const sig = ed25519.sign(message, SEED_A);
    expect(verifyEd25519Strict(sig, message, T.toRawBytes())).toBe(false);
    expect(verifyEd25519Strict(Uint8Array.from([...Point.ZERO.toRawBytes(), ...sig.subarray(32)]), message, ed25519.getPublicKey(SEED_A))).toBe(false);
  });
});

describe("TC-1540 Miller 6: address case and canonical subject", () => {
  const upper = `0x${HOLDER_LOWER.slice(2).toUpperCase()}`;
  test("a SIWE address that is lowercase, all-uppercase or badly checksummed is refused; the EIP-55 form passes", async () => {
    expect(upper).not.toBe(HOLDER_LOWER);
    for (const address of [HOLDER_LOWER, upper, HOLDER.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))]) {
      await expectCode("bad-siwe", {}, { address });
    }
    await expectCode("ok", {}, { address: HOLDER });
  });
  test("an all-uppercase did:pkh address is refused as sub", async () => {
    expect(pkhPrincipalsEqual(`did:pkh:eip155:1:${upper}`, SUB)).toBe(false);
    await expectCode("bad-subject", { payload: (p) => ({ ...p, sub: `did:pkh:eip155:1:${upper}`, holderBinding: { did: SUB, signingDomain: BINDING } }) });
  });
  test("result.subject is the canonical EIP-55 did:pkh even when the credential carries the lowercase form", async () => {
    const lowerSub = `did:pkh:eip155:1:${HOLDER_LOWER}`;
    const h = harness();
    const { presentation } = h.present({ payload: (p) => ({ ...p, sub: lowerSub, holderBinding: { did: lowerSub, signingDomain: BINDING } }) });
    const result = await verifyHeldPresentation(presentation, h.options);
    expect(result.subject).toBe(SUB);
    expect(result.subjectAddress).toBe(HOLDER_LOWER);
  });
});

describe("TC-1540 Miller 7: exact RFC 3339 in SIWE", () => {
  test("parseRfc3339 refuses impossible dates and times", () => {
    for (const bad of [
      "2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-19T24:00:00Z",
      "2026-10-19T23:60:00Z", "2026-10-19T23:59:60Z", "2026-10-19T00:00:00", "2026-10-19 00:00:00Z", "2026-10-19T00:00:00+24:00", "2026-10-19T00:00:00+01:60",
      "2026-10-19T00:00:00.Z", "2026-10-19T00:00:00z", "", "2026-10-19",
    ]) expect(parseRfc3339(bad)).toBeNull();
  });
  test("parseRfc3339 values", () => {
    expect(parseRfc3339("2026-10-19T00:00:00Z")).toBe(Date.UTC(2026, 9, 19));
    expect(parseRfc3339("2028-02-29T12:00:00.5Z")).toBe(Date.UTC(2028, 1, 29, 12, 0, 0, 500));
    expect(parseRfc3339("2026-10-19T02:00:00+02:00")).toBe(Date.UTC(2026, 9, 19));
    expect(parseRfc3339("2026-10-18T19:30:00-04:30")).toBe(Date.UTC(2026, 9, 19));
  });
  test("a SIWE with an impossible Expiration Time, Not Before or Issued At is refused; real ones pass", async () => {
    await expectCode("bad-siwe", {}, { expirationTime: "2026-02-31T00:00:00Z" });
    await expectCode("bad-siwe", {}, { expirationTime: "2026-10-21T24:00:00Z" });
    await expectCode("bad-siwe", {}, { notBefore: "2026-10-19T00:00:00+25:00" });
    await expectCode("ok", {}, { expirationTime: "2026-10-21T00:00:00Z", notBefore: "2026-10-19T00:00:00Z" });
    await expectCode("bad-siwe", {}, { expirationTime: "2026-10-19T00:00:00Z" });
  });
});

describe("TC-1540 Miller 8 and F1: opaque, immutable IssuerSet", () => {
  test("only parseIssuerSet can create an IssuerSet", () => {
    expect(() => new IssuerSet(Symbol("x"), 1, new Map())).toThrow(TypeError);
    expect(() => (IssuerSet as unknown as () => unknown)()).toThrow();
  });
  test("a structural object, a prototype-only object and a spread copy are refused as the issuerSet", async () => {
    const real = parseIssuerSet(setOf(entryA()), { didMethods: METHODS });
    const entry = real.resolveIssuer(ISSUER_A, KID_A)!;
    const structural = { version: 1, resolveIssuer: () => ({ ...entry, vcts: ["anything"], profiles: ["anything"] }) } as unknown as IssuerSet;
    for (const issuerSet of [structural, Object.create(IssuerSet.prototype) as IssuerSet, { ...real } as IssuerSet]) {
      await expectCode("bad-config", {}, undefined, { issuerSet });
    }
    expect(IssuerSet.is(real)).toBe(true);
    await expectCode("ok", {}, undefined, { issuerSet: real });
  });
  test("resolveIssuer cannot be overridden on the instance or the prototype: the override fails and verification is unchanged", async () => {
    const h = harness({}, [entryA(), entryA({ kid: `${ISSUER_A}#issuing-2`, publicKey: encodeBase64Url(ed25519.getPublicKey(SEED_B)) })]);
    const set = h.options.issuerSet as unknown as { resolveIssuer: unknown };
    const other = h.options.issuerSet.resolveIssuer(ISSUER_A, `${ISSUER_A}#issuing-2`)!;
    // test files are ES modules (strict mode), so assignment to a frozen object throws
    expect(() => { set.resolveIssuer = () => other; }).toThrow(TypeError);
    expect(() => Object.defineProperty(set, "resolveIssuer", { value: () => other })).toThrow(TypeError);
    expect(() => { (IssuerSet.prototype as unknown as { resolveIssuer: unknown }).resolveIssuer = () => other; }).toThrow(TypeError);
    expect(() => Object.defineProperty(IssuerSet.prototype, "resolveIssuer", { value: () => other })).toThrow(TypeError);
    expect(() => Object.defineProperty(IssuerSet, "is", { value: () => true })).toThrow(TypeError);
    expect(Object.isFrozen(set) && Object.isFrozen(IssuerSet.prototype) && Object.isFrozen(IssuerSet)).toBe(true);
    // an attacker-signed credential (key B, claiming issuer A) still does not verify
    const { presentation } = h.present({ seed: SEED_B });
    expect(await code(verifyHeldPresentation(presentation, h.options))).toBe("bad-signature");
  });
  test("mutating a returned entry's publicKey bytes does not change a later verification", async () => {
    const h = harness();
    const entry = h.options.issuerSet.resolveIssuer(ISSUER_A, KID_A)!;
    entry.publicKey.set(ed25519.getPublicKey(SEED_B)); // attacker swaps in their own key
    expect(h.options.issuerSet.resolveIssuer(ISSUER_A, KID_A)!.publicKey).toEqual(ed25519.getPublicKey(SEED_A));
    const forged = h.present({ seed: SEED_B });
    expect(await code(verifyHeldPresentation(forged.presentation, h.options))).toBe("bad-signature");
    const honest = h.present();
    expect(await code(verifyHeldPresentation(honest.presentation, h.options))).toBe("ok");
  });
  test("returned entries are fresh copies, and vcts and profiles are frozen", () => {
    const real = parseIssuerSet(setOf(entryA()), { didMethods: METHODS });
    const first = real.resolveIssuer(ISSUER_A, KID_A)!;
    expect(real.resolveIssuer(ISSUER_A, KID_A)).not.toBe(first);
    expect(real.resolveIssuer(ISSUER_A, KID_A)!.publicKey).not.toBe(first.publicKey);
    expect(Object.isFrozen(first.vcts) && Object.isFrozen(first.profiles)).toBe(true);
    expect(() => (first.vcts as string[]).push("x")).toThrow(TypeError);
  });
  test("resolved entries are frozen", () => {
    const real = parseIssuerSet(setOf(entryA()), { didMethods: METHODS });
    expect(Object.isFrozen(real.resolveIssuer(ISSUER_A, KID_A))).toBe(true);
  });
});

describe("TC-1540 Miller 9: email shape", () => {
  test("normaliseEmail refuses an empty local part or domain", () => {
    for (const bad of ["@ab", "ab@", "@", "+tag@example.com", "a@@b.com", "@example.com", "ab@.com"]) expect(normaliseEmail(bad)).toBeNull();
    expect(normaliseEmail("ab@example.com")).toBe("ab@example.com");
  });
  test("a disclosed email with an empty local part or domain is refused", async () => {
    for (const email of ["@ab", "ab@", "@a.b", "a@"]) {
      await expectCode("bad-disclosure", { disclosures: [["email", email]] });
    }
    await expectCode("ok", { disclosures: [["email", "ab@example.com"]] });
  });
});

const ORG_A = `did:web:o${"abcdefghijklmnopqrstuvwxyz"}.orgs.credentials.org`;
const ORG_A_KID = `${ORG_A}#issuing-1`;
const SEED_ORG_A = seed(200);
const PAID_PROFILE = "tinycloud.org-membership/v1";
const FREE_PROFILE = "tinycloud.org-membership-free/v1";
const ORG_VCT = "opencredentials.org-membership/v1";
const ORG_BINDING = "tinycloud.credentials/org-binding/v1";
const ALL_ROWS: readonly ProfileRow[] = [EMAIL_HELD_ROW, ...ORG_MEMBERSHIP_ROWS];

function orgEntry(profiles: string[], extra: Obj = {}): Obj {
  return {
    issuerDid: ORG_A, kid: ORG_A_KID, alg: "EdDSA", publicKey: encodeBase64Url(ed25519.getPublicKey(SEED_ORG_A)),
    vcts: [ORG_VCT], profiles, notBefore: "2026-10-01T00:00:00Z", retiredAt: null, notAfter: null, ...extra,
  };
}

/** An org membership credential. The free row's lifetime limit is 30 days, so its default exp is shorter. */
function orgCredential(profile: string, spec: CredentialSpec = {}): CredentialSpec {
  const lifetimeDays = profile === FREE_PROFILE ? 29 : 365;
  return {
    seed: SEED_ORG_A, iss: ORG_A, kid: ORG_A_KID,
    disclosures: [["role", "member"], ["membershipType", "team"]],
    ...spec,
    payload: (p) => {
      const merged: Obj = { ...p, profile, vct: ORG_VCT, exp: (p.iat as number) + lifetimeDays * DAY, holderBinding: { did: SUB, signingDomain: ORG_BINDING } };
      return spec.payload ? spec.payload(merged) : merged;
    },
  };
}

interface OrgCase {
  entries: Obj[];
  profiles: AcceptedProfile[];
  issuers: AcceptedIssuer[];
  /** Rows the verifier uses; defaults to every row. */
  rows?: readonly ProfileRow[];
}

async function orgCode(cred: CredentialSpec, c: OrgCase): Promise<string> {
  const store = new InMemoryNonceStore();
  const options: VerifyHeldPresentationOptions = {
    now: NOW, rows: c.rows ?? ALL_ROWS,
    issuerSet: parseIssuerSet(setOf(...c.entries), { didMethods: METHODS }),
    acceptedIssuers: c.issuers, acceptedProfiles: c.profiles,
    didMethods: METHODS, audience: AUDIENCE, nonceStore: store, callerAccount: SUB,
  };
  const nonce = store.issue(AUDIENCE, SUB);
  const { sdJwt } = makeCredential(cred);
  return code(verifyHeldPresentation({ sdJwt, siwe: makeSiwe(sdJwt, nonce) }, options));
}

function loadCode(entries: Obj[], rows?: readonly ProfileRow[]): string {
  try {
    parseIssuerSet(setOf(...entries), rows ? { didMethods: METHODS, rows } : { didMethods: METHODS });
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

function audienceCode(value: string): string {
  try {
    assertValidAudience(value);
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

describe("TC-1553: six-credential-type refusal matrix", () => {
  const ACCEPTED_ISSUERS = [{ issuerDid: ISSUER_A }, { issuerDid: ORG_A }];
  const ENTRIES = [entryA({ profiles: [PROFILE] }), orgEntry([PAID_PROFILE, FREE_PROFILE], { vcts: [ORG_VCT, VCT] })];
  /** Acceptance sets in column order: email-only, paid-only, free-only, paid+free. */
  const ACCEPTANCE: AcceptedProfile[][] = [
    [{ profile: PROFILE, profileVersion: 1 }],
    [{ profile: PAID_PROFILE, profileVersion: 1 }],
    [{ profile: FREE_PROFILE, profileVersion: 1 }],
    [{ profile: PAID_PROFILE, profileVersion: 1 }, { profile: FREE_PROFILE, profileVersion: 1 }],
  ];
  /** Real shapes for the other held-type cells. Each is refused at the first check its shape trips. */
  const TICKET_SUB = "did:key:z6MkTicketHolder";
  /** An acquisition ticket: held header, holder-binding domain, did:key subject, no profile. */
  const ticket = (): CredentialSpec => orgCredential(PAID_PROFILE, { payload: ({ profile, ...p }) => ({ ...p, sub: TICKET_SUB, holderBinding: { did: TICKET_SUB, signingDomain: "tinycloud.credentials/holder-binding/v1" } }) });
  /** A share credential: an otherwise valid held credential carrying the O3 `tinycloud_share` claim. */
  const o3 = (): CredentialSpec => orgCredential(PAID_PROFILE, { payload: (p) => ({ ...p, tinycloud_share: {} }) });
  /** A legacy record: `{"alg":"EdDSA"}` header with no `typ` and no `kid`, and no profile. */
  const legacy = (): CredentialSpec => orgCredential(PAID_PROFILE, { header: (h) => ({ alg: h.alg }), payload: ({ profile, ...p }) => p });
  const cases: [string, CredentialSpec, string[]][] = [
    ["email-held", {}, ["ok", "profile-not-accepted", "profile-not-accepted", "profile-not-accepted"]],
    ["paid org", orgCredential(PAID_PROFILE), ["profile-not-accepted", "ok", "profile-not-accepted", "ok"]],
    ["free org", orgCredential(FREE_PROFILE), ["profile-not-accepted", "profile-not-accepted", "ok", "ok"]],
    ["paid profile with the email vct", orgCredential(PAID_PROFILE, { payload: (p) => ({ ...p, vct: VCT }) }), ["profile-not-accepted", "profile-mismatch", "profile-not-accepted", "profile-mismatch"]],
    ["ticket", ticket(), ["bad-payload", "bad-payload", "bad-payload", "bad-payload"]],
    ["share-email O3", o3(), ["profile-not-accepted", "bad-payload", "profile-not-accepted", "bad-payload"]],
    ["legacy record", legacy(), ["bad-header", "bad-header", "bad-header", "bad-header"]],
  ];
  test("each credential type gets its expected code under each acceptance set", async () => {
    for (const [name, spec, expected] of cases) {
      const codes: string[] = [];
      for (const profiles of ACCEPTANCE) codes.push(await orgCode(spec, { entries: ENTRIES, profiles, issuers: ACCEPTED_ISSUERS }));
      expect({ name, codes }).toEqual({ name, codes: expected });
    }
  });
  test("an email profile identity issued by an org is refused at the issuer entry check", async () => {
    const cred: CredentialSpec = { iss: ORG_A, kid: ORG_A_KID, seed: SEED_ORG_A, payload: (p) => ({ ...p, profile: PROFILE, vct: VCT }) };
    expect(await orgCode(cred, { entries: [orgEntry([PAID_PROFILE])], profiles: [{ profile: PROFILE, profileVersion: 1 }], issuers: [{ issuerDid: ORG_A }] })).toBe("profile-mismatch");
  });
  test("an org credential whose entry omits the paid profile is refused at the issuer entry check", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE), { entries: [orgEntry([FREE_PROFILE])], profiles: [{ profile: PAID_PROFILE, profileVersion: 1 }], issuers: [{ issuerDid: ORG_A }] })).toBe("profile-mismatch");
  });
});

describe("TC-1553: org membership rows", () => {
  const accept = { profiles: [{ profile: PAID_PROFILE, profileVersion: 1 }], issuers: [{ issuerDid: ORG_A }] };
  const ORG_B = `did:web:o${"b".repeat(26)}.orgs.credentials.org`;
  const ORG_B_KID = `${ORG_B}#issuing-1`;
  const SEED_ORG_B = seed(201);
  const orgBEntry = () => orgEntry([PAID_PROFILE], { issuerDid: ORG_B, kid: ORG_B_KID, publicKey: encodeBase64Url(ed25519.getPublicKey(SEED_ORG_B)) });
  const orgBCredential = () => orgCredential(PAID_PROFILE, { seed: SEED_ORG_B, iss: ORG_B, kid: ORG_B_KID });
  test("cross-org: org B's credential cannot satisfy org A's policy", async () => {
    expect(await orgCode(orgBCredential(), { entries: [orgEntry([PAID_PROFILE]), orgBEntry()], ...accept })).toBe("issuer-not-accepted");
  });
  test("the same credential passes when the policy accepts org B", async () => {
    expect(await orgCode(orgBCredential(), { entries: [orgEntry([PAID_PROFILE]), orgBEntry()], profiles: accept.profiles, issuers: [{ issuerDid: ORG_B }] })).toBe("ok");
  });

  test("the free row refuses a credential longer than 30 days; the paid row allows 365", async () => {
    expect(await orgCode(orgCredential(FREE_PROFILE, { payload: (p) => ({ ...p, exp: (p.iat as number) + 365 * DAY }) }), { entries: [orgEntry([FREE_PROFILE])], profiles: [{ profile: FREE_PROFILE, profileVersion: 1 }], issuers: [{ issuerDid: ORG_A }] })).toBe("bad-lifetime");
    expect(await orgCode(orgCredential(PAID_PROFILE), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("ok");
  });
  test("role must be member or admin, and membershipType must be a lowercase slug", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE, { disclosures: [["role", "owner"]] }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-disclosure");
    expect(await orgCode(orgCredential(PAID_PROFILE, { disclosures: [["membershipType", "Team"]] }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-disclosure");
    expect(await orgCode(orgCredential(PAID_PROFILE, { disclosures: [["membershipType", "-team"]] }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-disclosure");
    expect(await orgCode(orgCredential(PAID_PROFILE, { disclosures: [["role", "admin"], ["membershipType", "team-a"]] }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("ok");
  });
  test("an email disclosure is outside the org row's disclosable list", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE, { disclosures: [["email", "alice@example.com"]] }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-disclosure");
  });
  test("the email holder-binding domain is refused by the org row", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE, { payload: (p) => ({ ...p, holderBinding: { did: SUB, signingDomain: BINDING } }) }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-holder-binding");
  });
  test("an unexpected signed claim is refused by the org row", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE, { payload: (p) => ({ ...p, email: "alice@example.com" }) }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-payload");
  });
  test("an org claim in the payload is refused by the org row", async () => {
    expect(await orgCode(orgCredential(PAID_PROFILE, { payload: (p) => ({ ...p, org: "acme" }) }), { entries: [orgEntry([PAID_PROFILE])], ...accept })).toBe("bad-payload");
  });
  test("the verifier applies the row's issuer rule when the set was loaded without it", async () => {
    const rowRefusingIssuerA: ProfileRow = { ...ORG_MEMBERSHIP_ROW, profile: "tinycloud.test-org/v1", permitsIssuer: (issuerDid) => issuerDid !== ISSUER_A };
    const cred = orgCredential("tinycloud.test-org/v1", { iss: ISSUER_A, kid: KID_A, seed: SEED_A });
    expect(await orgCode(cred, {
      entries: [entryA({ profiles: ["tinycloud.test-org/v1"], vcts: [ORG_VCT] })],
      profiles: [{ profile: "tinycloud.test-org/v1", profileVersion: 1 }], issuers: [{ issuerDid: ISSUER_A }],
      rows: [...ALL_ROWS, rowRefusingIssuerA],
    })).toBe("issuer-not-accepted");
  });
  test("the set loader refuses a non-org issuer that lists a membership profile", () => {
    expect(loadCode([entryA({ profiles: [PAID_PROFILE], vcts: [ORG_VCT] })], ALL_ROWS)).toBe("bad-issuer-set");
  });
  test("the set loader refuses did:web labels that are not an opaque org id", () => {
    for (const label of ["x", "zingo"]) {
      const issuerDid = `did:web:${label}.orgs.credentials.org`;
      expect(loadCode([orgEntry([FREE_PROFILE], { issuerDid, kid: `${issuerDid}#issuing-1` })], ALL_ROWS)).toBe("bad-issuer-set");
    }
    expect(loadCode([orgEntry([FREE_PROFILE], { issuerDid: "did:web:zingo.credentials.org", kid: "did:web:zingo.credentials.org#issuing-1" })], ALL_ROWS)).toBe("bad-issuer-set");
  });
  test("the set loader applies the shipped issuer rules whatever rows are passed", () => {
    expect(loadCode([orgEntry([PAID_PROFILE, FREE_PROFILE])], ALL_ROWS)).toBe("ok");
    expect(loadCode([entryA({ profiles: [PAID_PROFILE], vcts: [ORG_VCT] })])).toBe("bad-issuer-set");
    expect(loadCode([entryA({ profiles: [PAID_PROFILE], vcts: [ORG_VCT] })], [])).toBe("bad-issuer-set");
    expect(loadCode([orgEntry([PAID_PROFILE])], [])).toBe("ok");
  });
  test("the set loader also enforces caller rows against each listed profile", () => {
    const refusesEveryIssuer: ProfileRow = { ...ORG_MEMBERSHIP_ROW, permitsIssuer: () => false };
    expect(loadCode([orgEntry([PAID_PROFILE])], [...ALL_ROWS, refusesEveryIssuer])).toBe("bad-issuer-set");
    expect(loadCode([orgEntry([PAID_PROFILE])], ALL_ROWS)).toBe("ok");
  });
  test("the email profile is refused on an org-family issuer and on any other non-literal issuer", () => {
    expect(loadCode([orgEntry([PROFILE], { vcts: [VCT] })])).toBe("bad-issuer-set");
    expect(loadCode([entryA()])).toBe("ok");
    expect(loadCode([entryB()])).toBe("bad-issuer-set");
  });
  test("a witness entry that lists only the free row is refused at load under the default rows", () => {
    expect(loadCode([entryA({ profiles: [FREE_PROFILE], vcts: [ORG_VCT] })])).toBe("bad-issuer-set");
  });
  test("an entry mixing the email row and an org row is refused for either issuer family", () => {
    expect(loadCode([orgEntry([PAID_PROFILE, PROFILE], { vcts: [ORG_VCT, VCT] })])).toBe("bad-issuer-set");
    expect(loadCode([entryA({ profiles: [PROFILE, FREE_PROFILE], vcts: [VCT, ORG_VCT] })])).toBe("bad-issuer-set");
  });
  describe("a caller row without permitsIssuer", () => {
    const CUSTOM_PROFILE = "tinycloud.test-custom/v1";
    const customEntries = [entryA({ profiles: [CUSTOM_PROFILE], vcts: [ORG_VCT] })];
    const customAccept = { profiles: [{ profile: CUSTOM_PROFILE, profileVersion: 1 }], issuers: [{ issuerDid: ISSUER_A }] };
    const customCredential = () => orgCredential(CUSTOM_PROFILE, { iss: ISSUER_A, kid: KID_A, seed: SEED_A });
    /** Typed: `permitsIssuer` is optional, so `delete` type-checks on a copy of a shipped row. */
    const typedRow = (): ProfileRow => {
      const row: ProfileRow = { ...ORG_MEMBERSHIP_ROW, profile: CUSTOM_PROFILE };
      delete row.permitsIssuer;
      return row;
    };
    /** Plain JS: a row object with no `permitsIssuer` key, cast only at the boundary. */
    const plainJsRow = (): ProfileRow => Object.fromEntries(
      Object.entries({ ...ORG_MEMBERSHIP_ROW, profile: CUSTOM_PROFILE }).filter(([key]) => key !== "permitsIssuer"),
    ) as unknown as ProfileRow;
    for (const [label, makeRow] of [["typed", typedRow], ["plain JS", plainJsRow]] as const) {
      test(`a ${label} row without permitsIssuer loads and verifies under the default rule`, async () => {
        const rows = [...ALL_ROWS, makeRow()];
        expect(loadCode(customEntries, rows)).toBe("ok");
        expect(await orgCode(customCredential(), { entries: customEntries, rows, ...customAccept })).toBe("ok");
      });
    }
    test("the default rule does not relax a shipped row's issuer rule", () => {
      expect(loadCode([entryA({ profiles: [PAID_PROFILE, CUSTOM_PROFILE], vcts: [ORG_VCT] })], [...ALL_ROWS, typedRow()])).toBe("bad-issuer-set");
    });
    test("a permitsIssuer that is present but not a function is refused as bad-config, not read as permissive", async () => {
      for (const permitsIssuer of ["yes", null, false]) {
        const malformed = { ...ORG_MEMBERSHIP_ROW, profile: CUSTOM_PROFILE, permitsIssuer } as unknown as ProfileRow;
        expect(loadCode(customEntries, [...ALL_ROWS, malformed])).toBe("bad-config");
        expect(await orgCode(customCredential(), { entries: customEntries, rows: [...ALL_ROWS, malformed], ...customAccept })).toBe("bad-config");
      }
    });
    test("a rule that does not return exactly true refuses the issuer, whatever the value", async () => {
      const rules = [() => undefined, () => "true", () => 1, async () => true] as ((issuerDid: string) => unknown)[];
      for (const permitsIssuer of rules) {
        const row = { ...ORG_MEMBERSHIP_ROW, profile: CUSTOM_PROFILE, permitsIssuer } as unknown as ProfileRow;
        expect(loadCode(customEntries, [...ALL_ROWS, row])).toBe("bad-issuer-set");
        expect(await orgCode(customCredential(), { entries: customEntries, rows: [...ALL_ROWS, row], ...customAccept })).toBe("issuer-not-accepted");
      }
    });
  });
  test("lifetime boundaries: the free row admits 30 days and not a second more, the paid row admits 365 days and not a second more", async () => {
    const credentialWith = (profile: string, seconds: number) => orgCredential(profile, { payload: (p) => ({ ...p, exp: (p.iat as number) + seconds }) });
    const entriesFor = (profile: string) => ({ entries: [orgEntry([profile])], profiles: [{ profile, profileVersion: 1 }], issuers: [{ issuerDid: ORG_A }] });
    expect(await orgCode(credentialWith(FREE_PROFILE, 30 * DAY), entriesFor(FREE_PROFILE))).toBe("ok");
    expect(await orgCode(credentialWith(FREE_PROFILE, 30 * DAY + 1), entriesFor(FREE_PROFILE))).toBe("bad-lifetime");
    expect(await orgCode(credentialWith(PAID_PROFILE, 365 * DAY), entriesFor(PAID_PROFILE))).toBe("ok");
    expect(await orgCode(credentialWith(PAID_PROFILE, 365 * DAY + 1), entriesFor(PAID_PROFILE))).toBe("bad-lifetime");
  });
  test("org credentials refuse an org disclosure, a list status, and membershipType outside the slug bounds", async () => {
    const paid = (spec: CredentialSpec) => orgCode(orgCredential(PAID_PROFILE, spec), { entries: [orgEntry([PAID_PROFILE])], ...accept });
    expect(await paid({ disclosures: [["org", "acme"]] })).toBe("bad-disclosure");
    expect(await paid({ payload: (p) => ({ ...p, status: { method: "list" } }) })).toBe("bad-status");
    expect(await paid({ disclosures: [["membershipType", "team!"]] })).toBe("bad-disclosure");
    expect(await paid({ disclosures: [["membershipType", "a".repeat(64)]] })).toBe("bad-disclosure");
    expect(await paid({ disclosures: [["membershipType", "a".repeat(63)]] })).toBe("ok");
  });
  test("shipped rows and their nested containers are frozen", () => {
    for (const row of [EMAIL_HELD_ROW, ORG_MEMBERSHIP_ROW, ORG_MEMBERSHIP_FREE_ROW]) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.holder)).toBe(true);
      expect(Object.isFrozen(row.disclosable)).toBe(true);
      expect(Object.isFrozen(row.optionalSignedClaims)).toBe(true);
      expect(Object.isFrozen(row.statusMethods)).toBe(true);
      expect(() => { (row as { vct: string }).vct = "other.vct/v1"; }).toThrow(TypeError);
      expect(() => { (row.disclosable as string[]).push("org"); }).toThrow(TypeError);
    }
    expect(Object.isFrozen(ORG_MEMBERSHIP_ROWS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ROWS)).toBe(true);
    expect(Object.isFrozen(SHIPPED_ROWS)).toBe(true);
  });
});

describe("TC-1553: org issuer rule anchors", () => {
  const VALID = `did:web:o${"a".repeat(26)}.orgs.credentials.org`;
  test("the org rows admit the canonical org-family DID shape only", () => {
    for (const row of [ORG_MEMBERSHIP_ROW, ORG_MEMBERSHIP_FREE_ROW]) {
      expect(rowPermitsIssuer(row, VALID)).toBe(true);
      const refused = [
        `x${VALID}`, `${VALID}x`, `${VALID}.`,
        VALID.replace(".orgs.", "Xorgs."),
        `did:web:o${"a".repeat(25)}.orgs.credentials.org`,
        `did:web:o${"a".repeat(27)}.orgs.credentials.org`,
        `did:web:o${"a".repeat(25)}8.orgs.credentials.org`,
      ];
      for (const issuer of refused) expect(rowPermitsIssuer(row, issuer)).toBe(false);
    }
  });
  test("the email row admits only the literal issuer and refuses the org family", () => {
    expect(rowPermitsIssuer(EMAIL_HELD_ROW, VALID)).toBe(false);
    expect(rowPermitsIssuer(EMAIL_HELD_ROW, ISSUER_A)).toBe(true);
    expect(rowPermitsIssuer(EMAIL_HELD_ROW, ISSUER_B)).toBe(false);
    for (const nearMiss of [`${ISSUER_A}x`, `${ISSUER_A}.example`, "did:web:Issuer.credentials.org", "did:web:issuer.credentials", "did:web:evil.issuer.credentials.org"]) {
      expect(rowPermitsIssuer(EMAIL_HELD_ROW, nearMiss)).toBe(false);
    }
  });
  test("the email row's permitsIssuer getter is read exactly once per check", () => {
    const counted: ProfileRow = { ...EMAIL_HELD_ROW };
    let reads = 0;
    Object.defineProperty(counted, "permitsIssuer", {
      enumerable: true,
      get() {
        reads += 1;
        return EMAIL_HELD_ROW.permitsIssuer;
      },
    });
    expect(rowPermitsIssuer(counted, ISSUER_A)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("TC-1553: audience validator", () => {
  test("accepts a bare lowercase host, with an optional non-default port", () => {
    for (const good of ["billing.tinycloud.xyz", "localhost:8443", "billing.tinycloud.xyz:65535"]) expect(audienceCode(good)).toBe("ok");
  });
  test("refuses default ports, leading-zero or out-of-range ports, schemes, paths, uppercase and empty values", () => {
    for (const bad of ["billing.tinycloud.xyz:443", "billing.tinycloud.xyz:0443", "billing.tinycloud.xyz:0", "billing.tinycloud.xyz:65536", "https://billing.tinycloud.xyz", "billing.tinycloud.xyz/path", "billing.tinycloud.xyz:8443/", "Billing.tinycloud.xyz", ""]) {
      expect(audienceCode(bad)).toBe("bad-config");
    }
  });
});

// Credential-only verifier (S3.1). Synchronous; no nonce and no SIWE.
const VECTOR_DIR = new URL("./fixtures/held-email-v1/", import.meta.url);

/** Sync counterpart of `code()`: the credential-only verifier returns a value, not a promise. */
function credentialCode(sdJwt: unknown, overrides: Partial<HeldEmailCredentialOptions> = {}): string {
  try {
    verifyHeldEmailCredential(sdJwt, {
      now: NOW, issuerSet: parseIssuerSet(setOf(entryA()), { didMethods: METHODS }),
      acceptedIssuers: [{ issuerDid: ISSUER_A }], didMethods: METHODS, owner: SUB, ...overrides,
    });
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

/** Sync counterpart for `sdHash`, which refuses with a HeldCredentialError. */
function hashCode(value: unknown): string {
  try {
    sdHash(value as string);
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

/** Sync counterpart for `selectDisclosures`. */
function selectCode(sdJwt: string, names: string[]): string {
  try {
    selectDisclosures(sdJwt, names);
    return "ok";
  } catch (error) {
    if (error instanceof HeldCredentialError) return error.code;
    throw error;
  }
}

describe("verifyHeldEmailCredential and selectDisclosures (credential only)", () => {
  test("P1: the shipped Node vector verifies", async () => {
    const vector = await Bun.file(new URL("vector.json", VECTOR_DIR)).json();
    const verified = verifyHeldEmailCredential(vector.sdJwt, {
      now: new Date(vector.now),
      issuerSet: parseIssuerSet(vector.issuerSet, { didMethods: METHODS }),
      acceptedIssuers: [{ issuerDid: "did:web:issuer.credentials.org" }],
      didMethods: METHODS,
      owner: vector.account,
    });
    expect(verified.subject).toBe(vector.account);
    expect(verified.claims.email).toBe(vector.email);
    expect(verified.profile).toBe(PROFILE);
  });

  test("P2: selectDisclosures keeps only the email disclosure; sdHash matches the shipped reference", async () => {
    const vector = await Bun.file(new URL("vector.json", VECTOR_DIR)).json();
    const reference = await Bun.file(new URL("sd-hash.json", VECTOR_DIR)).json();
    const parts = selectDisclosures(vector.sdJwt, ["email"]).split("~");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(vector.sdJwt.split("~")[0]);
    expect(parts[2]).toBe("");
    expect(JSON.parse(decodeUtf8(decodeBase64Url(parts[1], "bad-disclosure"), "bad-disclosure"))[1]).toBe("email");
    expect(sdHash(reference.sdJwt)).toBe(reference.sdHash);
  });

  test("N1 owner mismatch is refused with nonce-account-mismatch", () => {
    expect(credentialCode(makeCredential().sdJwt, { owner: `did:pkh:eip155:1:${toChecksumAddress(addressOf(otherKey))}` })).toBe("nonce-account-mismatch");
  });

  test("N2 chain other than 1 is refused with bad-subject", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, sub: `did:pkh:eip155:137:${HOLDER}`, holderBinding: { did: `did:pkh:eip155:137:${HOLDER}`, signingDomain: BINDING } }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-subject");
  });

  test("N3 wrong binding domain is refused with bad-holder-binding", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, holderBinding: { did: SUB, signingDomain: "tinycloud.credentials/other/v1" } }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-holder-binding");
  });

  test("N4 status other than none is refused with bad-status", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, status: { method: "revoked" } }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-status");
  });

  test("N5 typ other than vc+sd-jwt is refused with bad-header", () => {
    const sdJwt = makeCredential({ header: (h) => ({ ...h, typ: "jwt" }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-header");
  });

  test("N6 alg other than EdDSA is refused with bad-header", () => {
    const sdJwt = makeCredential({ header: (h) => ({ ...h, alg: "ES256" }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-header");
  });

  test("N7 a kid that is not accepted by the caller is refused with issuer-not-accepted", () => {
    expect(credentialCode(makeCredential().sdJwt, { acceptedIssuers: [{ issuerDid: ISSUER_A, kid: `${ISSUER_A}#other` }] })).toBe("issuer-not-accepted");
  });

  test("N8 a credential issued after the issuer key was retired is refused with issuer-retired", () => {
    const issuerSet = parseIssuerSet(setOf(entryA({ retiredAt: "2026-10-19T23:00:00Z" })), { didMethods: METHODS });
    expect(credentialCode(makeCredential().sdJwt, { issuerSet })).toBe("issuer-retired");
  });

  test("N9 a missing iat is refused with bad-payload", () => {
    const sdJwt = makeCredential({ payload: (p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "iat")) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-payload");
  });

  test("N10 exp - iat above 31,536,000 seconds is refused with bad-lifetime", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, exp: (p.iat as number) + 365 * DAY + 1 }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-lifetime");
  });

  test("N11 nbf later than now is refused with not-yet-valid", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, iat: NOW_S + 60, nbf: NOW_S + 60, exp: NOW_S + 60 + 365 * DAY }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("not-yet-valid");
  });

  test("N12 exp at or before now is refused with expired", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, exp: NOW_S - 1 }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("expired");
  });

  test("N13 a repeated _sd digest is refused with bad-payload", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, _sd: [(p._sd as string[])[0], (p._sd as string[])[0]] }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-payload");
  });

  test("N14 an unexpected signed claim is refused with bad-payload", () => {
    const sdJwt = makeCredential({ payload: (p) => ({ ...p, extra: "x" }) }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-payload");
  });

  test("N15 a key-binding suffix is refused with bad-presentation", () => {
    expect(credentialCode(`${makeCredential().sdJwt}a.b.c`)).toBe("bad-presentation");
  });

  test("N16 a non-ASCII email disclosure is refused with bad-disclosure", () => {
    const sdJwt = makeCredential({ disclosures: [["email", "alicé@example.com"], ["emailDomain", "example.com"]] }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-disclosure");
  });

  test("N17 a flipped signature byte is refused with bad-signature", () => {
    const sdJwt = makeCredential({ signature: (sig) => { const flipped = sig.slice(); flipped[0] ^= 1; return flipped; } }).sdJwt;
    expect(credentialCode(sdJwt)).toBe("bad-signature");
  });

  test("M2 owner in lowercase form for the EIP-55 subject is accepted", () => {
    expect(credentialCode(makeCredential().sdJwt, { owner: `did:pkh:eip155:1:${HOLDER_LOWER}` })).toBe("ok");
  });

  test("M2b the same address on chain 137 is refused with nonce-account-mismatch", () => {
    expect(credentialCode(makeCredential().sdJwt, { owner: `did:pkh:eip155:137:${HOLDER}` })).toBe("nonce-account-mismatch");
  });

  test("S1 sdHash refuses non-ASCII and non-string input with bad-presentation", () => {
    expect(hashCode("\u0169")).toBe("bad-presentation");
    expect(hashCode(42)).toBe("bad-presentation");
    expect(hashCode(undefined)).toBe("bad-presentation");
  });

  test("S2 selectDisclosures refuses a repeated disclosure for a requested name with bad-disclosure", () => {
    const sdJwt = makeCredential({ rawDisclosures: [disclosure("email", "alice@example.com").text] }).sdJwt;
    expect(selectCode(sdJwt, ["email"])).toBe("bad-disclosure");
  });

  test("S3 selectDisclosures refuses empty or duplicate names with bad-config", () => {
    const sdJwt = makeCredential().sdJwt;
    expect(selectCode(sdJwt, [])).toBe("bad-config");
    expect(selectCode(sdJwt, ["email", "email"])).toBe("bad-config");
  });

  test("S4 selectDisclosures refuses an absent name with bad-disclosure and a key-binding suffix with bad-presentation", () => {
    const sdJwt = makeCredential().sdJwt;
    expect(selectCode(sdJwt, ["phone"])).toBe("bad-disclosure");
    expect(selectCode(`${sdJwt}a.b.c`, ["email"])).toBe("bad-presentation");
  });
});
