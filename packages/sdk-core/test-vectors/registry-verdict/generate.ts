/**
 * Regenerates registry-verdict-v1.json:
 *
 *   bun packages/sdk-core/test-vectors/registry-verdict/generate.ts
 *
 * Output is deterministic: fixed test keys (NOT for production), fixed
 * timestamps, and deterministic signatures (Ed25519; RFC 6979 ECDSA).
 */

import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { privateKeyToAccount } from "viem/accounts";
import {
  httpUrlToMultiaddr,
  signLocationRecord,
  type LocationRecord,
  type LocationRecordPayload,
} from "../../src/location";
import { REGISTRY_LOOKUP_MAX_BODY_BYTES } from "../../src/registry-verdict";

const OUT = new URL("./registry-verdict-v1.json", import.meta.url);
const UPDATED_AT = "2026-10-18T00:00:00.000Z";

// Test-only keys. The first two match location.test.ts.
const ownerAccount = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const keySeed = new Uint8Array(32).fill(9);

const OWNER = `did:pkh:eip155:1:${ownerAccount.address}`;
const OTHER = `did:pkh:eip155:1:${otherAccount.address}`;
const KEY_SUBJECT = `did:key:${bases.base58btc.encode(
  Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(keySeed)),
)}`;

const NODE_A = "https://owner-node.example";
const NODE_B = "https://backup-node.example:8443";
const LOOPBACK = "http://127.0.0.1:8081";

async function pkhRecord(
  account: typeof ownerAccount,
  payload: Partial<LocationRecordPayload> & Pick<LocationRecordPayload, "multiaddrs" | "sequence">,
): Promise<LocationRecord> {
  return signLocationRecord(
    { version: 1, subject: `did:pkh:eip155:1:${account.address}`, updated_at: UPDATED_AT, ...payload },
    { type: "did:pkh", signMessage: (message) => account.signMessage({ message }) },
  );
}

const ownerRecord = await pkhRecord(ownerAccount, {
  multiaddrs: [httpUrlToMultiaddr(NODE_A), httpUrlToMultiaddr(NODE_B)],
  sequence: 5,
});
const tombstone = await pkhRecord(ownerAccount, { multiaddrs: [], sequence: 6 });
const mixedTransports = await pkhRecord(ownerAccount, {
  multiaddrs: ["/ip4/192.0.2.1/udp/4001/quic-v1", "/dns4/owner-node.example/tcp/443/https"],
  sequence: 7,
});
// Signed by OTHER but claiming OWNER as subject.
const forged = await signLocationRecord(
  { version: 1, subject: OWNER, multiaddrs: [httpUrlToMultiaddr("https://attacker.example")], updated_at: UPDATED_AT, sequence: 9 },
  { type: "did:pkh", signMessage: (message) => otherAccount.signMessage({ message }) },
);
const otherRecord = await pkhRecord(otherAccount, {
  multiaddrs: [httpUrlToMultiaddr("https://attacker.example")],
  sequence: 9,
});
const keyRecord = await signLocationRecord(
  { version: 1, subject: KEY_SUBJECT, multiaddrs: [httpUrlToMultiaddr(LOOPBACK)], updated_at: UPDATED_AT, sequence: 3 },
  { type: "did:key", signBytes: async (bytes) => ed25519.sign(bytes, keySeed) },
);

const ok = (record: unknown) => JSON.stringify({ record });
const http = (status: number, body: string, trailingSpaces?: number) => ({
  kind: "http",
  status,
  body,
  ...(trailingSpaces === undefined ? {} : { trailingSpaces }),
});
const NOT_FOUND = JSON.stringify({ error: "location record not found" });
const ownerHosts = [
  { urls: [NODE_A], source: "offchain" },
  { urls: [NODE_B], source: "offchain" },
];
const registered = (sequence: number, hosts: unknown[]) => ({ status: "registered", source: "offchain", sequence, hosts });
const unregistered = { status: "unregistered", source: "offchain", hosts: [] };
const unavailable = (reason: string) => ({ status: "unavailable", source: "offchain", reason, hosts: [] });

type Vector = {
  name: string;
  subject: string;
  rememberedSequence: number | null;
  response: unknown;
  expected: unknown;
};

const v = (
  name: string,
  subject: string,
  rememberedSequence: number | null,
  response: unknown,
  expected: unknown,
): Vector => ({ name, subject, rememberedSequence, response, expected });

const okBody = ok(ownerRecord);

const vectors: Vector[] = [
  // registered
  v("registered-pkh-two-hosts", OWNER, null, http(200, okBody), registered(5, ownerHosts)),
  v("registered-did-key-loopback", KEY_SUBJECT, null, http(200, ok(keyRecord)), registered(3, [{ urls: [LOOPBACK], source: "offchain" }])),
  v("registered-empty-hosts-tombstone", OWNER, null, http(200, ok(tombstone)), registered(6, [])),
  v("registered-non-http-multiaddr-omitted", OWNER, null, http(200, ok(mixedTransports)), registered(7, [{ urls: [NODE_A], source: "offchain" }])),
  v("registered-sequence-equal-to-remembered", OWNER, 5, http(200, okBody), registered(5, ownerHosts)),
  v("registered-sequence-above-remembered", OWNER, 4, http(200, okBody), registered(5, ownerHosts)),
  v("registered-extra-top-level-keys-ignored", OWNER, null, http(200, JSON.stringify({ record: ownerRecord, status: "updated" })), registered(5, ownerHosts)),
  v(
    "registered-body-at-size-limit",
    OWNER,
    null,
    http(200, okBody, REGISTRY_LOOKUP_MAX_BODY_BYTES - okBody.length),
    registered(5, ownerHosts),
  ),

  // unregistered
  v("unregistered-registry-not-found", OWNER, null, http(404, NOT_FOUND), unregistered),
  v("unregistered-registry-not-found-whitespace", OWNER, null, http(404, '{ "error" : "location record not found" }\n'), unregistered),

  // unavailable: not-found that is not the registry's, or contradicts memory
  v("unavailable-not-found-after-registered", OWNER, 0, http(404, NOT_FOUND), unavailable("not-found-after-registered")),
  v("unavailable-not-found-html", OWNER, null, http(404, "<html><body>404 Not Found</body></html>"), unavailable("malformed-response")),
  v("unavailable-not-found-plain-text", OWNER, null, http(404, "404 Not Found"), unavailable("malformed-response")),
  v("unavailable-not-found-empty-body", OWNER, null, http(404, ""), unavailable("malformed-response")),
  v("unavailable-not-found-other-error", OWNER, null, http(404, JSON.stringify({ error: "not found" })), unavailable("malformed-response")),
  v("unavailable-not-found-extra-key", OWNER, null, http(404, JSON.stringify({ error: "location record not found", record: null })), unavailable("malformed-response")),
  v("unavailable-not-found-array", OWNER, null, http(404, JSON.stringify(["location record not found"])), unavailable("malformed-response")),
  v("unavailable-not-found-oversize", OWNER, null, http(404, NOT_FOUND, REGISTRY_LOOKUP_MAX_BODY_BYTES - NOT_FOUND.length + 1), unavailable("oversize-response")),

  // unavailable: transport and status
  v("unavailable-network-error", OWNER, null, { kind: "network-error" }, unavailable("network-error")),
  v("unavailable-timeout", OWNER, null, { kind: "timeout" }, unavailable("timeout")),
  v("unavailable-timeout-with-remembered", OWNER, 5, { kind: "timeout" }, unavailable("timeout")),
  v("unavailable-http-500", OWNER, null, http(500, JSON.stringify({ error: "internal" })), unavailable("http-status")),
  v("unavailable-http-502", OWNER, null, http(502, "Bad Gateway"), unavailable("http-status")),
  v("unavailable-http-503", OWNER, null, http(503, ""), unavailable("http-status")),
  v("unavailable-http-429", OWNER, null, http(429, ""), unavailable("http-status")),
  v("unavailable-http-403", OWNER, null, http(403, NOT_FOUND), unavailable("http-status")),
  v("unavailable-http-410", OWNER, null, http(410, NOT_FOUND), unavailable("http-status")),
  v("unavailable-http-302", OWNER, null, http(302, ""), unavailable("http-status")),
  v("unavailable-http-204", OWNER, null, http(204, ""), unavailable("http-status")),
  v("unavailable-http-201-with-record", OWNER, null, http(201, okBody), unavailable("http-status")),

  // unavailable: malformed 200
  v("unavailable-ok-not-json", OWNER, null, http(200, "<html></html>"), unavailable("malformed-response")),
  v("unavailable-ok-empty-body", OWNER, null, http(200, ""), unavailable("malformed-response")),
  v("unavailable-ok-json-null", OWNER, null, http(200, "null"), unavailable("malformed-response")),
  v("unavailable-ok-json-array", OWNER, null, http(200, JSON.stringify([ownerRecord])), unavailable("malformed-response")),
  v("unavailable-ok-missing-record", OWNER, null, http(200, JSON.stringify({ ok: true })), unavailable("malformed-response")),
  v("unavailable-ok-record-null", OWNER, null, http(200, JSON.stringify({ record: null })), unavailable("malformed-response")),
  v("unavailable-ok-bare-record", OWNER, null, http(200, JSON.stringify(ownerRecord)), unavailable("malformed-response")),
  v("unavailable-ok-version-2", OWNER, null, http(200, ok({ ...ownerRecord, version: 2 })), unavailable("malformed-response")),
  v("unavailable-ok-negative-sequence", OWNER, null, http(200, ok({ ...ownerRecord, sequence: -1 })), unavailable("malformed-response")),
  v("unavailable-ok-fractional-sequence", OWNER, null, http(200, ok({ ...ownerRecord, sequence: 5.5 })), unavailable("malformed-response")),
  v("unavailable-ok-missing-signature", OWNER, null, http(200, ok({ ...ownerRecord, signature: undefined })), unavailable("malformed-response")),
  v("unavailable-ok-empty-signature", OWNER, null, http(200, ok({ ...ownerRecord, signature: "" })), unavailable("malformed-response")),
  v("unavailable-ok-multiaddrs-not-array", OWNER, null, http(200, ok({ ...ownerRecord, multiaddrs: NODE_A })), unavailable("malformed-response")),
  v("unavailable-ok-invalid-multiaddr", OWNER, null, http(200, ok({ ...ownerRecord, multiaddrs: ["not-a-multiaddr"] })), unavailable("malformed-response")),
  v("unavailable-ok-bad-updated-at", OWNER, null, http(200, ok({ ...ownerRecord, updated_at: "yesterday" })), unavailable("malformed-response")),
  v("unavailable-ok-oversize", OWNER, null, http(200, okBody, REGISTRY_LOOKUP_MAX_BODY_BYTES - okBody.length + 1), unavailable("oversize-response")),

  // unavailable: subject and signature
  v("unavailable-subject-mismatch-other-owner", OWNER, null, http(200, ok(otherRecord)), unavailable("subject-mismatch")),
  v("unavailable-subject-mismatch-case", OWNER.toLowerCase(), null, http(200, okBody), unavailable("subject-mismatch")),
  v("unavailable-subject-mismatch-did-key", OWNER, null, http(200, ok(keyRecord)), unavailable("subject-mismatch")),
  v("unavailable-signature-by-other-key", OWNER, null, http(200, ok(forged)), unavailable("invalid-signature")),
  v("unavailable-signature-tampered-hosts", OWNER, null, http(200, ok({ ...ownerRecord, multiaddrs: [httpUrlToMultiaddr("https://attacker.example")] })), unavailable("invalid-signature")),
  v("unavailable-signature-tampered-sequence", OWNER, null, http(200, ok({ ...ownerRecord, sequence: 50 })), unavailable("invalid-signature")),
  v("unavailable-signature-tombstone-replayed-as-hosts", OWNER, null, http(200, ok({ ...tombstone, multiaddrs: ownerRecord.multiaddrs })), unavailable("invalid-signature")),
  v("unavailable-signature-not-hex", OWNER, null, http(200, ok({ ...ownerRecord, signature: "not-hex" })), unavailable("invalid-signature")),
  v("unavailable-signature-did-key-wrong-length", KEY_SUBJECT, null, http(200, ok({ ...keyRecord, signature: "AAAA" })), unavailable("invalid-signature")),
  v("unavailable-signature-did-key-tampered", KEY_SUBJECT, null, http(200, ok({ ...keyRecord, sequence: 4 })), unavailable("invalid-signature")),

  // unavailable: rollback below remembered sequence
  v("unavailable-rollback-below-remembered", OWNER, 6, http(200, okBody), unavailable("rollback")),
  v("unavailable-rollback-tombstone-below-remembered", OWNER, 7, http(200, ok(tombstone)), unavailable("rollback")),
  v("unavailable-forged-checked-before-rollback", OWNER, 100, http(200, ok(forged)), unavailable("invalid-signature")),
];

const names = new Set(vectors.map((vector) => vector.name));
if (names.size !== vectors.length) throw new Error("duplicate vector name");

const file = {
  format: "tinycloud/registry-verdict-vectors",
  version: 1,
  description:
    "Classification of one off-chain location registry v1 lookup (GET /v1/locations/:subject) into the three-state registry verdict (TC-1443, TC-1444). Every implementation must produce `expected` for each vector. Records are signed with fixed test keys (NOT for production); regenerate with generate.ts.",
  rules: [
    "response.kind is http, network-error or timeout. For http, the body is `body` followed by `trailingSpaces` (default 0) ASCII spaces.",
    "Checks in order, first failure wins: network-error, timeout; status not 200 or 404 -> http-status; body over 65536 UTF-8 bytes -> oversize-response.",
    "404: the body must parse as a JSON object whose only key is `error` with value \"location record not found\", else malformed-response. Then, if rememberedSequence is not null -> not-found-after-registered, else unregistered.",
    "200: the body must parse as a JSON object with a `record` that is a valid v1 location record, else malformed-response. record.subject must equal subject exactly -> subject-mismatch. The signature must verify (any signature decoding error counts) -> invalid-signature. record.sequence below rememberedSequence -> rollback; equal is accepted.",
    "registered.hosts: one host per record multiaddr that maps to an http(s) URL, in record order, as {urls:[url], source:\"offchain\"}; other multiaddrs are omitted. A record with no multiaddrs is registered with hosts [].",
    "Every verdict has source \"offchain\". unregistered and unavailable have hosts [].",
  ],
  subjects: { owner: OWNER, other: OTHER, didKey: KEY_SUBJECT },
  vectors,
};

await Bun.write(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors`);
