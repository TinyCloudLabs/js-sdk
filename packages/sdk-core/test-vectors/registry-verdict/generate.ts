/**
 * Regenerates registry-verdict-v1.json:
 *
 *   bun packages/sdk-core/test-vectors/registry-verdict/generate.ts
 *
 * Output is deterministic: fixed test keys (NOT for production), fixed
 * timestamps, and deterministic signatures (Ed25519; RFC 6979 ECDSA).
 * Records are signed directly over the v1 signed bytes, without the SDK's
 * own record validation, so invalid-but-signed records can be expressed.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { bases } from "multiformats/basics";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalLocationPayload, type LocationRecordPayload } from "../../src/location";
import { REGISTRY_LOOKUP_MAX_BODY_BYTES, REGISTRY_NOT_FOUND_BODY } from "../../src/registry-verdict";

const OUT = new URL("./registry-verdict-v1.json", import.meta.url);
const UPDATED_AT = "2026-10-18T00:00:00.000Z";
const MAX = REGISTRY_LOOKUP_MAX_BODY_BYTES;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaae6dedaf48a03bbfd25e8cd0364141n;
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

// Test-only keys. The first and the seed match location.test.ts.
const ownerAccount = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const keySeed = new Uint8Array(32).fill(9);
const keyPublic = ed25519.getPublicKey(keySeed);

const ADDRESS = ownerAccount.address;
const OWNER = `did:pkh:eip155:1:${ADDRESS}`;
const OWNER_137 = `did:pkh:eip155:137:${ADDRESS}`;
const OTHER = `did:pkh:eip155:1:${otherAccount.address}`;
const KEY_SUBJECT = `did:key:${bases.base58btc.encode(Uint8Array.of(0xed, 0x01, ...keyPublic))}`;
const LEGACY_KEY_SUBJECT = `did:key:${bases.base58btc.encode(Uint8Array.of(0xed, ...keyPublic))}`;

const NODE_A = "https://owner-node.example";
const NODE_B = "https://backup-node.example:8443";
const MA_A = "/dns/owner-node.example/tcp/443/tls/http";
const MA_B = "/dns/backup-node.example/tcp/8443/tls/http";
const LOOPBACK_MA = "/ip4/127.0.0.1/tcp/8081/http";

type Payload = LocationRecordPayload;
type SignedRecord = Payload & { signature: string };

const payload = (overrides: Partial<Payload> = {}): Payload => ({
  version: 1,
  subject: OWNER,
  multiaddrs: [MA_A, MA_B],
  updated_at: UPDATED_AT,
  sequence: 5,
  ...overrides,
});

async function signPkh(account: typeof ownerAccount, body: Payload): Promise<SignedRecord> {
  return { ...body, signature: await account.signMessage({ message: canonicalLocationPayload(body) }) };
}

function signKey(body: Payload): SignedRecord {
  const signature = ed25519.sign(new TextEncoder().encode(canonicalLocationPayload(body)), keySeed);
  return { ...body, signature: Buffer.from(signature).toString("base64url") };
}

const owner = (overrides: Partial<Payload> = {}) => signPkh(ownerAccount, payload(overrides));

const ownerRecord = await owner();
const tombstone = await owner({ multiaddrs: [], sequence: 6 });
const keyRecord = signKey(payload({ subject: KEY_SUBJECT, multiaddrs: [LOOPBACK_MA], sequence: 3 }));
const forged = await signPkh(otherAccount, payload({ multiaddrs: ["/dns/attacker.example/tcp/443/tls/http"], sequence: 9 }));
const otherRecord = await signPkh(otherAccount, payload({ subject: OTHER, multiaddrs: ["/dns/attacker.example/tcp/443/tls/http"], sequence: 9 }));
const lowercaseSubjectRecord = await owner({ subject: OWNER.toLowerCase() });
const chain137Record = await owner({ subject: OWNER_137 });
const legacyKeyRecord = signKey(payload({ subject: LEGACY_KEY_SUBJECT, multiaddrs: [LOOPBACK_MA], sequence: 3 }));

// did:pkh signature variants of ownerRecord.
const sig = ownerRecord.signature;
const r = sig.slice(2, 66);
const s = BigInt(`0x${sig.slice(66, 130)}`);
const v = sig.slice(130);
const flippedV = v === "1b" ? "1c" : "1b";
const highS = (SECP256K1_N - s).toString(16).padStart(64, "0");
const yParity = v === "1b" ? "00" : "01";

// did:key signature variants of keyRecord.
const keySig = keyRecord.signature;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Same 2 data bits in the last character, different 4 ignored bits.
const lastIndex = BASE64URL.indexOf(keySig.at(-1)!);
const trailingBitsSig = keySig.slice(0, -1) + BASE64URL[(lastIndex & 0b110000) | ((lastIndex & 0b1111) ^ 0b0101)];
const keySigBytes = Buffer.from(keySig, "base64url");
const sPlusL = (() => {
  let scalar = 0n;
  for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) | BigInt(keySigBytes[i]);
  scalar += ED25519_L;
  const out = Buffer.from(keySigBytes);
  for (let i = 32; i < 64; i++) {
    out[i] = Number(scalar & 0xffn);
    scalar >>= 8n;
  }
  return out.toString("base64url");
})();

type BodyPart = string | { repeat: string; count: number };
type Body = string | BodyPart[];
const ok = (record: unknown) => JSON.stringify({ record });
const http = (status: number, body: Body) => ({ kind: "http", status, body });
const okBody = ok(ownerRecord);
const ownerHosts = [
  { urls: [NODE_A], source: "offchain" },
  { urls: [NODE_B], source: "offchain" },
];
const registered = (sequence: number, hosts: unknown[]) => ({ status: "registered", source: "offchain", sequence, hosts });
const unregistered = { status: "unregistered", source: "offchain", hosts: [] };
const unavailable = (reason: string) => ({ status: "unavailable", source: "offchain", reason, hosts: [] });
const inputError = (error: string) => ({ error });

interface Vector {
  name: string;
  subject: string;
  rememberedSequence: unknown;
  response: unknown;
  expected: unknown;
}
const vector = (
  name: string,
  subject: string,
  rememberedSequence: unknown,
  response: unknown,
  expected: unknown,
): Vector => ({ name, subject, rememberedSequence, response, expected });

const NOT_FOUND = http(404, REGISTRY_NOT_FOUND_BODY);
const vectors: Vector[] = [];
const add = (...args: Parameters<typeof vector>) => vectors.push(vector(...args));

// --- input contract -------------------------------------------------------
add("input-chain-137-subject-is-valid", OWNER_137, null, NOT_FOUND, unregistered);
for (const [name, subject] of [
  ["lowercase-address", OWNER.toLowerCase()],
  ["uppercase-address", `did:pkh:eip155:1:0x${ADDRESS.slice(2).toUpperCase()}`],
  ["wrong-checksum", `did:pkh:eip155:1:${ADDRESS.slice(0, -1)}${ADDRESS.at(-1) === ADDRESS.at(-1)!.toLowerCase() ? ADDRESS.at(-1)!.toUpperCase() : ADDRESS.at(-1)!.toLowerCase()}`],
  ["chain-zero", `did:pkh:eip155:0:${ADDRESS}`],
  ["chain-leading-zero", `did:pkh:eip155:01:${ADDRESS}`],
  ["chain-beyond-safe-integer", `did:pkh:eip155:9007199254740992:${ADDRESS}`],
  ["non-eip155-namespace", `did:pkh:bip122:000000000019d6689c085ae165831e93:${ADDRESS}`],
  ["missing-chain", `did:pkh:eip155:${ADDRESS}`],
  ["trailing-fragment", `${OWNER}#controller`],
  ["did-web", "did:web:example.com"],
  ["empty", ""],
  ["did-key-legacy-33-byte", LEGACY_KEY_SUBJECT],
  ["did-key-35-byte", `did:key:${bases.base58btc.encode(Uint8Array.of(0xed, 0x01, ...keyPublic, 0x00))}`],
  ["did-key-secp256k1", `did:key:${bases.base58btc.encode(Uint8Array.of(0xe7, 0x01, 0x02, ...new Uint8Array(32).fill(1)))}`],
  ["did-key-not-base58btc", `did:key:${bases.base32.encode(Uint8Array.of(0xed, 0x01, ...keyPublic))}`],
  ["did-key-trailing-data", `${KEY_SUBJECT}x`],
] as const) {
  add(`input-invalid-subject-${name}`, subject, null, NOT_FOUND, inputError("invalid-subject"));
}
for (const [name, remembered] of [
  ["negative", -1],
  ["fraction", 1.5],
  ["beyond-safe-integer", 9007199254740992],
  ["string", "5"],
  ["boolean", true],
] as const) {
  add(`input-invalid-remembered-sequence-${name}`, OWNER, remembered, NOT_FOUND, inputError("invalid-remembered-sequence"));
}

// --- registered -----------------------------------------------------------
add("registered-pkh-two-hosts", OWNER, null, http(200, okBody), registered(5, ownerHosts));
add("registered-did-key-loopback", KEY_SUBJECT, null, http(200, ok(keyRecord)), registered(3, [{ urls: ["http://127.0.0.1:8081"], source: "offchain" }]));
add("registered-chain-137-subject", OWNER_137, null, http(200, ok(chain137Record)), registered(5, ownerHosts));
add("registered-empty-hosts-tombstone", OWNER, null, http(200, ok(tombstone)), registered(6, []));
add("registered-sequence-equal-to-remembered", OWNER, 5, http(200, okBody), registered(5, ownerHosts));
add("registered-sequence-above-remembered", OWNER, 4, http(200, okBody), registered(5, ownerHosts));
add("registered-remembered-zero", OWNER, 0, http(200, okBody), registered(5, ownerHosts));
add("registered-extra-top-level-key-ignored", OWNER, null, http(200, JSON.stringify({ record: ownerRecord, status: "updated" })), registered(5, ownerHosts));
add("registered-extra-record-key-ignored", OWNER, null, http(200, ok({ ...ownerRecord, nodeDid: KEY_SUBJECT, expires_at: UPDATED_AT })), registered(5, ownerHosts));
add("registered-key-order-irrelevant", OWNER, null, http(200, JSON.stringify({ record: { signature: sig, sequence: 5, updated_at: UPDATED_AT, multiaddrs: [MA_A, MA_B], subject: OWNER, version: 1 } })), registered(5, ownerHosts));
add("registered-escaped-record-key", OWNER, null, http(200, `{"\\u0072ecord":${JSON.stringify(ownerRecord)}}`), registered(5, ownerHosts));
add("registered-proto-key-is-ordinary", OWNER, null, http(200, `{"record":${JSON.stringify(ownerRecord)},"__proto__":{"record":null}}`), registered(5, ownerHosts));
add("registered-whitespace-around-json", OWNER, null, http(200, ` \t\r\n${okBody}\n`), registered(5, ownerHosts));
add("registered-negative-integer-in-ignored-key", OWNER, null, http(200, `{"record":${JSON.stringify(ownerRecord)},"x":-12}`), registered(5, ownerHosts));
add(
  "registered-json-depth-32",
  OWNER,
  null,
  http(200, `{"record":${JSON.stringify(ownerRecord)},"x":${"[".repeat(31)}${"]".repeat(31)}}`),
  registered(5, ownerHosts),
);
const sequenceMax = await owner({ sequence: Number.MAX_SAFE_INTEGER });
add("registered-sequence-max-safe-integer", OWNER, null, http(200, ok(sequenceMax)), registered(Number.MAX_SAFE_INTEGER, ownerHosts));

// --- updated_at -----------------------------------------------------------
for (const [name, updatedAt] of [
  ["no-fraction", "2026-10-18T00:00:00Z"],
  ["offset", "2026-10-18T05:30:00+05:30"],
  ["negative-offset", "2026-10-17T19:00:00-05:00"],
  ["long-fraction", "2024-02-29T23:59:59.123456789Z"],
  ["leap-day-2000", "2000-02-29T00:00:00Z"],
] as const) {
  add(`registered-updated-at-${name}`, OWNER, null, http(200, ok(await owner({ updated_at: updatedAt }))), registered(5, ownerHosts));
}
for (const [name, updatedAt] of [
  ["impossible-date", "2026-02-30T00:00:00Z"],
  ["non-leap-2025", "2025-02-29T00:00:00Z"],
  ["non-leap-1900", "1900-02-29T00:00:00Z"],
  ["month-13", "2026-13-01T00:00:00Z"],
  ["day-zero", "2026-10-00T00:00:00Z"],
  ["hour-24", "2026-10-18T24:00:00Z"],
  ["leap-second", "2026-12-31T23:59:60Z"],
  ["offset-hour-24", "2026-10-18T00:00:00+24:00"],
  ["offset-no-colon", "2026-10-18T00:00:00+0000"],
  ["no-zone", "2026-10-18T00:00:00"],
  ["lowercase-t-z", "2026-10-18t00:00:00z"],
  ["space-separator", "2026-10-18 00:00:00Z"],
  ["date-only", "2026-10-18"],
  ["year-only", "2026"],
  ["number-string", "1"],
  ["words", "Oct 18 2026"],
  ["empty-fraction", "2026-10-18T00:00:00.Z"],
  ["non-ascii-digits", "２０２６-10-18T00:00:00Z"],
] as const) {
  add(`unavailable-updated-at-${name}`, OWNER, null, http(200, ok(await owner({ updated_at: updatedAt }))), unavailable("malformed-response"));
}

// --- hosts: one record per multiaddr --------------------------------------
const hostCases: Array<[string, string, string | null]> = [
  ["dns-tls-http", "/dns/x.example/tcp/443/tls/http", "https://x.example"],
  ["dns4-https", "/dns4/x.example/tcp/443/https", "https://x.example"],
  ["dns6-uppercase-port", "/dns6/X.Example/tcp/8443/https", "https://x.example:8443"],
  ["dns-http-default-port", "/dns4/x.example/tcp/80/http", "http://x.example"],
  ["dns-http-on-443", "/dns4/x.example/tcp/443/http", "http://x.example:443"],
  ["dns-max-port", "/dns4/x.example/tcp/65535/https", "https://x.example:65535"],
  ["dns-localhost", "/dns4/localhost/tcp/8081/http", "http://localhost:8081"],
  ["dns-punycode", "/dns4/xn--bcher-kva.example/tcp/443/https", "https://xn--bcher-kva.example"],
  ["ip4-unspecified", "/ip4/0.0.0.0/tcp/80/http", "http://0.0.0.0"],
  ["ip4-link-local", "/ip4/169.254.169.254/tcp/80/http", "http://169.254.169.254"],
  ["ip4-private-https", "/ip4/10.0.0.1/tcp/443/https", "https://10.0.0.1"],
  ["ip4-loopback", "/ip4/127.0.0.1/tcp/8081/http", "http://127.0.0.1:8081"],
  ["ip6-loopback", "/ip6/::1/tcp/8081/http", "http://[::1]:8081"],
  ["ip6-uncompressed-uppercase", "/ip6/2001:DB8:0:0:0:0:0:1/tcp/443/https", "https://[2001:db8::1]"],
  ["ip6-v4-mapped", "/ip6/::ffff:1.2.3.4/tcp/80/http", "http://[::ffff:102:304]"],
  ["userinfo", "/dns4/evil.example@good.example/tcp/443/https", null],
  ["query", "/dns4/good.example?x=1/tcp/443/https", null],
  ["fragment", "/dns4/good.example#frag/tcp/443/https", null],
  ["http-path", "/dns4/x.example/tcp/443/https/http-path/%2Fadmin", null],
  ["sni", "/ip4/1.2.3.4/tcp/443/tls/sni/other.example/http", null],
  ["no-scheme", "/dns4/x.example/tcp/443", null],
  ["no-tcp", "/dns4/x.example/https", null],
  ["port-zero", "/dns4/x.example/tcp/0/https", null],
  ["port-65536", "/dns4/x.example/tcp/65536/https", null],
  ["port-leading-zero", "/dns4/x.example/tcp/0443/https", null],
  ["ip4-leading-zero", "/ip4/01.2.3.4/tcp/80/http", null],
  ["ip4-octet-256", "/ip4/256.1.1.1/tcp/80/http", null],
  ["dns-numeric-last-label", "/dns4/1.2.3.4/tcp/443/https", null],
  ["dns-trailing-dot", "/dns4/x.example./tcp/443/https", null],
  ["dns-leading-hyphen", "/dns4/-x.example/tcp/443/https", null],
  ["dns-non-ascii", "/dns4/bücher.example/tcp/443/https", null],
  ["ip6-zone", "/ip6zone/eth0/ip6/fe80::1/tcp/80/http", null],
  ["ip6-invalid", "/ip6/:::/tcp/80/http", null],
  ["quic", "/ip4/1.2.3.4/udp/4001/quic-v1", null],
  ["wss", "/dns4/x.example/tcp/443/wss", null],
  ["trailing-slash", "/dns4/x.example/tcp/443/https/", null],
  ["no-leading-slash", "dns4/x.example/tcp/443/https", null],
  ["uppercase-protocol", "/DNS4/x.example/tcp/443/https", null],
  ["not-a-multiaddr", "not-a-multiaddr", null],
];
for (const [name, address, origin] of hostCases) {
  add(
    `hosts-${name}`,
    OWNER,
    null,
    http(200, ok(await owner({ multiaddrs: [address], sequence: 10 }))),
    registered(10, origin === null ? [] : [{ urls: [origin], source: "offchain" }]),
  );
}
add(
  "hosts-record-order-unusable-entries-omitted",
  OWNER,
  null,
  http(200, ok(await owner({ multiaddrs: ["not-a-multiaddr", MA_A, "/ip4/1.2.3.4/udp/4001/quic-v1", LOOPBACK_MA, MA_A], sequence: 10 }))),
  registered(10, [
    { urls: [NODE_A], source: "offchain" },
    { urls: ["http://127.0.0.1:8081"], source: "offchain" },
    { urls: [NODE_A], source: "offchain" },
  ]),
);

// --- unregistered and not-found -------------------------------------------
add("unregistered-registry-not-found", OWNER, null, NOT_FOUND, unregistered);
add("unregistered-not-found-did-key", KEY_SUBJECT, null, NOT_FOUND, unregistered);
add("unregistered-not-found-outer-whitespace", OWNER, null, http(404, ` \t\r\n${REGISTRY_NOT_FOUND_BODY}\r\n\t `), unregistered);
add("unavailable-not-found-after-registered", OWNER, 0, NOT_FOUND, unavailable("not-found-after-registered"));
for (const [name, body] of [
  ["inner-whitespace", '{ "error": "location record not found" }'],
  ["duplicate-key", '{"error":"x","error":"location record not found"}'],
  ["escaped-key", '{"\\u0065rror":"location record not found"}'],
  ["escaped-value", '{"error":"location record not f\\u006fund"}'],
  ["proto-key", '{"__proto__":{"error":"location record not found"}}'],
  ["extra-key", '{"error":"location record not found","record":null}'],
  ["other-error", '{"error":"not found"}'],
  ["array", '["location record not found"]'],
  ["bom", `\uFEFF${REGISTRY_NOT_FOUND_BODY}`],
  ["nbsp", `${REGISTRY_NOT_FOUND_BODY}\u00A0`],
  ["html", "<html><body>404 Not Found</body></html>"],
  ["plain-text", "404 Not Found"],
  ["empty", ""],
] as const) {
  add(`unavailable-not-found-${name}`, OWNER, null, http(404, body), unavailable("malformed-response"));
}

// --- body size --------------------------------------------------------------
add("registered-body-at-size-limit", OWNER, null, http(200, [okBody, { repeat: " ", count: MAX - okBody.length }]), registered(5, ownerHosts));
add("unavailable-ok-oversize", OWNER, null, http(200, [okBody, { repeat: " ", count: MAX - okBody.length + 1 }]), unavailable("oversize-response"));
add("unavailable-not-found-oversize", OWNER, null, http(404, [REGISTRY_NOT_FOUND_BODY, { repeat: " ", count: MAX - REGISTRY_NOT_FOUND_BODY.length + 1 }]), unavailable("oversize-response"));
{
  // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: the limit is in bytes.
  const prefix = `{"record":${JSON.stringify(ownerRecord)},"pad":"`;
  const suffix = '"}';
  const ascii = prefix.length + suffix.length;
  const atLimit = Math.floor((MAX - ascii) / 2);
  add(
    "registered-non-ascii-body-at-byte-limit",
    OWNER,
    null,
    http(200, [prefix, { repeat: "é", count: atLimit }, suffix, { repeat: " ", count: (MAX - ascii) % 2 }]),
    registered(5, ownerHosts),
  );
  add(
    "unavailable-non-ascii-body-over-byte-limit",
    OWNER,
    null,
    http(200, [prefix, { repeat: "é", count: Math.ceil((MAX - ascii + 1) / 2) }, suffix]),
    unavailable("oversize-response"),
  );
}

// --- transport and status -------------------------------------------------
add("unavailable-network-error", OWNER, null, { kind: "network-error" }, unavailable("network-error"));
add("unavailable-timeout", OWNER, null, { kind: "timeout" }, unavailable("timeout"));
add("unavailable-timeout-with-remembered", OWNER, 5, { kind: "timeout" }, unavailable("timeout"));
for (const [status, body] of [
  [500, '{"error":"internal"}'],
  [502, "Bad Gateway"],
  [503, ""],
  [429, ""],
  [403, REGISTRY_NOT_FOUND_BODY],
  [410, REGISTRY_NOT_FOUND_BODY],
  [302, ""],
  [204, ""],
  [201, okBody],
] as const) {
  add(`unavailable-http-${status}`, OWNER, null, http(status, body), unavailable("http-status"));
}

// --- malformed 200 ----------------------------------------------------------
const recordJson = JSON.stringify(ownerRecord);
for (const [name, body] of [
  ["not-json", "<html></html>"],
  ["empty-body", ""],
  ["json-null", "null"],
  ["json-array", JSON.stringify([ownerRecord])],
  ["missing-record", '{"ok":true}'],
  ["record-null", '{"record":null}'],
  ["record-array", `{"record":[${recordJson}]}`],
  ["bare-record", recordJson],
  ["proto-wrapped-record", `{"__proto__":{"record":${recordJson}}}`],
  ["duplicate-record-key", `{"record":null,"record":${recordJson}}`],
  ["duplicate-key-in-record", okBody.replace('"version":1,', '"sequence":4,"version":1,')],
  ["sequence-5.0", okBody.replace('"sequence":5,', '"sequence":5.0,')],
  ["sequence-5e0", okBody.replace('"sequence":5,', '"sequence":5e0,')],
  ["sequence-5E0", okBody.replace('"sequence":5,', '"sequence":5E0,')],
  ["sequence-minus-zero", okBody.replace('"sequence":5,', '"sequence":-0,')],
  ["sequence-leading-zero", okBody.replace('"sequence":5,', '"sequence":05,')],
  ["sequence-string", okBody.replace('"sequence":5,', '"sequence":"5",')],
  ["sequence-negative", ok({ ...ownerRecord, sequence: -1 })],
  ["sequence-beyond-safe-integer", okBody.replace('"sequence":5,', '"sequence":9007199254740992,')],
  ["version-1.0", okBody.replace('"version":1,', '"version":1.0,')],
  ["version-string", okBody.replace('"version":1,', '"version":"1",')],
  ["version-2", ok({ ...ownerRecord, version: 2 })],
  ["float-in-ignored-key", `{"record":${recordJson},"x":1.5}`],
  ["json-depth-33", `{"record":${recordJson},"x":${"[".repeat(32)}${"]".repeat(32)}}`],
  ["lone-high-surrogate-escape", `{"record":${recordJson},"x":"\\ud800"}`],
  ["lone-low-surrogate-escape", `{"record":${recordJson},"x":"\\udc00"}`],
  ["high-surrogate-escape-then-text", `{"record":${recordJson},"x":"\\ud800xxdc00"}`],
  ["high-surrogate-escape-then-non-surrogate-escape", `{"record":${recordJson},"x":"\\ud800\\u0041"}`],
  ["bad-escape", `{"record":${recordJson},"x":"\\q"}`],
  ["raw-control-character", `{"record":${recordJson},"x":"a\u0001b"}`],
  ["bom", `\uFEFF${okBody}`],
  ["trailing-data", `${okBody}{}`],
  ["trailing-comma", `{"record":${recordJson},}`],
  ["single-quotes", okBody.replaceAll('"', "'")],
  ["missing-signature", ok({ ...ownerRecord, signature: undefined })],
  ["empty-signature", ok({ ...ownerRecord, signature: "" })],
  ["subject-not-string", ok({ ...ownerRecord, subject: 1 })],
  ["multiaddrs-not-array", ok({ ...ownerRecord, multiaddrs: MA_A })],
  ["multiaddrs-empty-string", ok({ ...ownerRecord, multiaddrs: [MA_A, ""] })],
  ["multiaddrs-non-string", ok({ ...ownerRecord, multiaddrs: [MA_A, 1] })],
  ["updated-at-missing", ok({ ...ownerRecord, updated_at: undefined })],
] as const) {
  add(`unavailable-ok-${name}`, OWNER, null, http(200, body), unavailable("malformed-response"));
}

// --- subject ------------------------------------------------------------------
add("unavailable-subject-mismatch-other-owner", OWNER, null, http(200, ok(otherRecord)), unavailable("subject-mismatch"));
add("unavailable-subject-mismatch-lowercase-record-subject", OWNER, null, http(200, ok(lowercaseSubjectRecord)), unavailable("subject-mismatch"));
add("unavailable-subject-mismatch-other-chain", OWNER, null, http(200, ok(chain137Record)), unavailable("subject-mismatch"));
add("unavailable-subject-mismatch-did-key-for-pkh", OWNER, null, http(200, ok(keyRecord)), unavailable("subject-mismatch"));
add("unavailable-subject-mismatch-legacy-did-key", KEY_SUBJECT, null, http(200, ok(legacyKeyRecord)), unavailable("subject-mismatch"));

// --- signatures -------------------------------------------------------------
add("registered-pkh-signature-v-as-y-parity", OWNER, null, http(200, ok({ ...ownerRecord, signature: `0x${r}${sig.slice(66, 130)}${yParity}` })), registered(5, ownerHosts));
add("registered-pkh-signature-uppercase-hex", OWNER, null, http(200, ok({ ...ownerRecord, signature: `0x${sig.slice(2).toUpperCase()}` })), registered(5, ownerHosts));
add("registered-did-key-signature-nonzero-trailing-bits", KEY_SUBJECT, null, http(200, ok({ ...keyRecord, signature: trailingBitsSig })), registered(3, [{ urls: ["http://127.0.0.1:8081"], source: "offchain" }]));
for (const [name, signature] of [
  ["high-s-flipped-v", `0x${r}${highS}${flippedV}`],
  ["high-s-same-v", `0x${r}${highS}${v}`],
  ["wrong-y-parity", `0x${r}${sig.slice(66, 130)}${yParity === "00" ? "01" : "00"}`],
  ["v-29", `0x${r}${sig.slice(66, 130)}1d`],
  ["r-zero", `0x${"0".repeat(64)}${sig.slice(66)}`],
  ["r-equals-n", `0x${SECP256K1_N.toString(16)}${sig.slice(66)}`],
  ["s-zero", `0x${r}${"0".repeat(64)}${v}`],
  ["eip-2098-64-byte", sig.slice(0, 130)],
  ["trailing-byte", `${sig}00`],
  ["uppercase-0x-prefix", `0X${sig.slice(2)}`],
  ["no-0x-prefix", sig.slice(2)],
  ["not-hex", "not-hex"],
] as const) {
  add(`unavailable-pkh-signature-${name}`, OWNER, null, http(200, ok({ ...ownerRecord, signature })), unavailable("invalid-signature"));
}
add("unavailable-pkh-signature-by-other-key", OWNER, null, http(200, ok(forged)), unavailable("invalid-signature"));
for (const [name, record] of [
  ["tampered-hosts", { ...ownerRecord, multiaddrs: ["/dns/attacker.example/tcp/443/tls/http"] }],
  ["tampered-sequence", { ...ownerRecord, sequence: 50 }],
  ["tampered-updated-at", { ...ownerRecord, updated_at: "2026-10-18T00:00:00Z" }],
  ["tombstone-replayed-with-hosts", { ...tombstone, multiaddrs: ownerRecord.multiaddrs }],
] as const) {
  add(`unavailable-pkh-signature-${name}`, OWNER, null, http(200, ok(record)), unavailable("invalid-signature"));
}
for (const [name, signature] of [
  ["padded", `${keySig}==`],
  ["standard-base64-alphabet", Buffer.from(keySig, "base64url").toString("base64").replace(/=+$/, "")],
  ["wrong-length", "AAAA"],
  ["s-plus-l", sPlusL],
  ["tampered", keySig.slice(0, 10) + (keySig[10] === "A" ? "B" : "A") + keySig.slice(11)],
] as const) {
  add(`unavailable-did-key-signature-${name}`, KEY_SUBJECT, null, http(200, ok({ ...keyRecord, signature })), unavailable("invalid-signature"));
}
add("unavailable-did-key-signature-tampered-sequence", KEY_SUBJECT, null, http(200, ok({ ...keyRecord, sequence: 4 })), unavailable("invalid-signature"));
{
  // Accepted by noble's ZIP-215 mode, rejected by RFC 8032 strict decoding.
  const L = ED25519_L;
  const scalarLE = (n: bigint) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  };
  const challenge = (rBytes: Uint8Array, aBytes: Uint8Array, message: Uint8Array) => {
    const digest = sha512(new Uint8Array([...rBytes, ...aBytes, ...message]));
    let k = 0n;
    for (let i = 63; i >= 0; i--) k = (k << 8n) | BigInt(digest[i]);
    return k % L;
  };
  const identity = scalarLE(1n);
  const identityNonCanonical = scalarLE(2n ** 255n - 18n); // y = p + 1

  // R = identity with y encoded as p + 1, S = k·a: the group equation holds.
  const body = payload({ subject: KEY_SUBJECT, multiaddrs: [LOOPBACK_MA], sequence: 3 });
  const message = new TextEncoder().encode(canonicalLocationPayload(body));
  const { scalar } = ed25519.utils.getExtendedPublicKey(keySeed);
  const nonCanonicalR = new Uint8Array([...identityNonCanonical, ...scalarLE((challenge(identity, keyPublic, message) * scalar) % L)]);
  // did:key whose public key is the identity point (small order): R = identity, S = 0 verifies any message.
  const smallOrderSubject = `did:key:${bases.base58btc.encode(Uint8Array.of(0xed, 0x01, ...identity))}`;
  const smallOrderBody = payload({ subject: smallOrderSubject, multiaddrs: ["/dns/attacker.example/tcp/443/tls/http"], sequence: 1 });
  const smallOrderSig = new Uint8Array([...identity, ...new Uint8Array(32)]);
  for (const [sig, msg, key] of [
    [nonCanonicalR, message, keyPublic],
    [smallOrderSig, new TextEncoder().encode(canonicalLocationPayload(smallOrderBody)), identity],
  ] as const) {
    if (!ed25519.verify(sig, msg, key, { zip215: true }) || ed25519.verify(sig, msg, key, { zip215: false })) {
      throw new Error("Ed25519 strictness vector does not separate ZIP-215 from RFC 8032");
    }
  }
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  add("unavailable-did-key-signature-non-canonical-r", KEY_SUBJECT, null, http(200, ok({ ...body, signature: b64(nonCanonicalR) })), unavailable("invalid-signature"));
  add("unavailable-did-key-signature-small-order-key", smallOrderSubject, null, http(200, ok({ ...smallOrderBody, signature: b64(smallOrderSig) })), unavailable("invalid-signature"));
}

// --- rollback -----------------------------------------------------------------
add("unavailable-rollback-below-remembered", OWNER, 6, http(200, okBody), unavailable("rollback"));
add("unavailable-rollback-tombstone-below-remembered", OWNER, 7, http(200, ok(tombstone)), unavailable("rollback"));
add("unavailable-forged-checked-before-rollback", OWNER, 100, http(200, ok(forged)), unavailable("invalid-signature"));

const names = new Set(vectors.map((entry) => entry.name));
if (names.size !== vectors.length) throw new Error("duplicate vector name");

const file = {
  format: "tinycloud/registry-verdict-vectors",
  version: 2,
  description:
    "Classification of one off-chain location registry v1 lookup (GET /v1/locations/:subject) into the three-state registry verdict (TC-1443, TC-1444). Every implementation must produce `expected` for each vector. Records are signed with fixed test keys (NOT for production); regenerate with generate.ts.",
  rules: [
    "Inputs. subject must be did:pkh:eip155:<chainId>:<address> with chainId a decimal safe integer >= 1 without leading zeros and address in EIP-55 checksum form, or did:key:z<base58btc> decoding to exactly 0xed 0x01 + 32 bytes. rememberedSequence is null or a non-negative safe integer (<= 2^53-1). Otherwise the result is the input error in `expected.error` (invalid-subject, then invalid-remembered-sequence).",
    "Response. kind is http, network-error or timeout. For http, `body` is a string or an array of parts, concatenated; a part is a string or {repeat, count} meaning `repeat` repeated `count` times.",
    "Order, first failure wins: network-error; timeout; status not 200 or 404 -> http-status; body over 65536 UTF-8 bytes -> oversize-response.",
    "404: the body with leading and trailing SP, HT, LF and CR removed must equal exactly the bytes {\"error\":\"location record not found\"}, else malformed-response. No JSON parsing. Then rememberedSequence not null -> not-found-after-registered, else unregistered.",
    "200 strict JSON: RFC 8259 (whitespace SP, HT, LF, CR only; no BOM; no trailing data), plus: duplicate keys in any object, any number with a fraction or exponent, nesting deeper than 32 arrays/objects (the top level counts as 1), and \\u escapes of unpaired surrogates are malformed-response. Escapes are decoded before comparing keys. `__proto__` is an ordinary key.",
    "200 record: the top-level value must be an object with key `record` whose value is an object holding version (the integer 1), subject (string), multiaddrs (array of non-empty strings; not parsed as multiaddrs), updated_at (string, RFC 3339 date-time: YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM), uppercase T and Z, ASCII digits, a real calendar date (Gregorian leap years), hour <= 23, minute <= 59, second <= 59, offset hour <= 23, offset minute <= 59), sequence (non-negative integer literal without leading zeros or minus, <= 2^53-1) and signature (non-empty string). Other keys at any level are ignored. Any failure is malformed-response.",
    "record.subject must equal the input subject exactly, else subject-mismatch.",
    "Signed bytes: UTF-8 of JSON.stringify({version, subject, multiaddrs, updated_at, sequence}) in that key order (ECMAScript JSON serialization). did:pkh: EIP-191 personal_sign recovering the subject's address (EOA only); signature is 0x followed by 130 hex digits of either case encoding r || s || v with 1 <= r < n, 1 <= s <= n/2 (low-s), v in {0, 1, 27, 28}. did:key: Ed25519 per RFC 8032 with strict decoding (A and R canonical, y < p; S < L; A not of small order) and the cofactored group equation [8]SB = [8]R + [8]kA; signature is exactly 86 base64url characters, no padding, final 4 bits ignored. Any failure is invalid-signature.",
    "rememberedSequence not null and record.sequence < rememberedSequence -> rollback. Equal is accepted.",
    "registered.hosts: one host {urls:[origin], source:\"offchain\"} per record multiaddr, in record order, no deduplication, for entries matching exactly /(ip4|ip6|dns|dns4|dns6)/<host>/tcp/<port>/(http|https|tls/http) with port 1-65535 without leading zeros. ip4 host: dotted quad, octets 0-255 without leading zeros. ip6 host: characters [0-9A-Fa-f:.] containing ':' that parse as an IPv6 address. dns hosts: ASCII LDH labels of 1-63 characters, no leading or trailing hyphen, total <= 253, no trailing dot, last label not all digits. Scheme: http for http, https for https and tls/http. origin is the WHATWG URL origin of scheme://host:port (lowercased host, compressed IPv6 in brackets, default port omitted). Other entries are omitted. No HTTPS, address-class or identity filtering.",
    "Every verdict has source \"offchain\". unregistered and unavailable have hosts [].",
  ],
  subjects: { owner: OWNER, ownerChain137: OWNER_137, other: OTHER, didKey: KEY_SUBJECT, legacyDidKey: LEGACY_KEY_SUBJECT },
  vectors,
};

await Bun.write(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors`);
