import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
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
import { MAX_JSON_DEPTH, decodeUtf8, asciiBytes, bytesToHex, encodeBase64Url, parseStrictJson } from "./encoding";
import { HELD_LIMITS } from "./verify";
import { verifyEd25519Strict } from "./crypto";
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
