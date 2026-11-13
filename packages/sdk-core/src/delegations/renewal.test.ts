import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { DelegationStatusSchema } from "./types.schema";
import { encodeDagCbor } from "./cacao";
import { verifyRenewalHistory, type RenewalStampHistoryEntry } from "./renewal";

const originalCid = "bafkreigh2akiscaildcw7v5h2q7v7m2k4p5g7v2b6n2m7w4x6r4h3a2b6e";
const leaseCid = "bafkreigh2akiscaildcw7v5h2q7v7m2k4p5g7v2b6n2m7w4x6r4h3a2b6f";
const nodeKey = ed25519.getPublicKey(new Uint8Array(32).fill(9));
const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...nodeKey]))}`;
const seed = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(seed);
const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;

function makeStamp(input: {
  generation: number;
  previousStampCid: string;
  newEnd: number;
  original?: string;
  lease?: string;
  signer?: Uint8Array;
}): RenewalStampHistoryEntry {
  const end = new Date(input.newEnd * 1000).toISOString().replace(".000Z", "Z");
  const signedBytes = encodeDagCbor({
    domain: "tinycloud/node/renewal-stamp/v1",
    unsigned: {
      type: "TinyCloudRenewalStamp",
      newEnd: end,
      nodeDid,
      version: 1,
      leaseCid: input.lease ?? leaseCid,
      originalCid: input.original ?? originalCid,
      renewerEpoch: 1,
      leaseGeneration: input.generation,
      previousStampCid: input.previousStampCid,
    },
  });
  const signature = ed25519.sign(signedBytes, input.signer ?? seed);
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(signedBytes))).toString();
  return {
    cid,
    lease_cid: input.lease ?? leaseCid,
    generation: input.generation,
    previous_stamp_cid: input.previousStampCid,
    new_end: input.newEnd,
    signed_bytes: Buffer.from(signedBytes).toString("base64url"),
    signature: Buffer.from(signature).toString("base64url"),
  };
}

const identity = {
  nodeDid,
  renewerDid,
  renewerPublicKey: Buffer.from(publicKey).toString("base64url"),
  renewerEpoch: 1,
};

function verify(history: readonly RenewalStampHistoryEntry[]) {
  return verifyRenewalHistory({
    originalCid,
    leaseCid,
    leaseExpiresAt: 1_800_000_000,
    nodeIdentity: identity,
    history,
    now: 1_700_000_000,
  });
}

describe("verifyRenewalHistory", () => {
  test("accepts a node-signed admitted stamp bound to the exact lease and original", () => {
    const stamp = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_750_000_000 });
    expect(verify([stamp])).toEqual({ effectiveExpiry: 1_750_000_000, latestStampCid: stamp.cid });
  });

  test("refuses a changed signature, a gap, or a stamp for another delegation", () => {
    const first = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_710_000_000 });
    const second = makeStamp({ generation: 1, previousStampCid: first.cid, newEnd: 1_750_000_000 });
    expect(() => verify([{ ...first, signature: Buffer.alloc(64).toString("base64url") }])).toThrow();
    expect(() => verify([{ ...second, generation: 1, previous_stamp_cid: leaseCid }])).toThrow();
    const wrongOriginal = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_750_000_000, original: "bafkreigh2akiscaildcw7v5h2q7v7m2k4p5g7v2b6n2m7w4x6r4h3a2b60" });
    expect(() => verify([wrongOriginal])).toThrow();
    expect(verify([second, first])).toEqual({ effectiveExpiry: 1_750_000_000, latestStampCid: second.cid });
    const fork = makeStamp({ generation: 1, previousStampCid: first.cid, newEnd: 1_740_000_000 });
    expect(() => verify([first, second, fork])).toThrow();
  });
  test("binds history to the discovered node identity and current epoch", () => {
    const stamp = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_750_000_000 });
    expect(() => verifyRenewalHistory({
      originalCid,
      leaseCid,
      leaseExpiresAt: 1_800_000_000,
      nodeIdentity: { ...identity, nodeDid: "did:web:other.example" },
      history: [stamp],
      now: 1_700_000_000,
    })).toThrow();
    expect(() => verifyRenewalHistory({
      originalCid,
      leaseCid,
      leaseExpiresAt: 1_800_000_000,
      nodeIdentity: { ...identity, renewerEpoch: 2 },
      history: [stamp],
      now: 1_700_000_000,
    })).toThrow();
    expect(() => verifyRenewalHistory({
      originalCid,
      leaseCid,
      leaseExpiresAt: 1_800_000_000,
      nodeIdentity: { ...identity, renewerPublicKey: Buffer.alloc(32, 8).toString("base64url") },
      history: [stamp],
      now: 1_700_000_000,
    })).toThrow();
  });
  test("keeps an admitted stamp valid across an explicit lease re-enable", () => {
    const first = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_710_000_000 });
    const reenabled = makeStamp({ generation: 2, previousStampCid: first.cid, newEnd: 1_750_000_000 });
    expect(verify([reenabled, first])).toEqual({ effectiveExpiry: 1_750_000_000, latestStampCid: reenabled.cid });
  });

  test("refuses a chain whose tip exceeds the lease or is stale", () => {
    const beyondLease = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_800_000_001 });
    const afterNow = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_699_999_999 });
    expect(() => verify([beyondLease])).toThrow();
    expect(() => verify([afterNow])).toThrow();
  });
});
describe("DelegationStatusSchema renewal fields", () => {
  test("keeps pre-renewal node responses compatible and parses signed history without treating it as authority", () => {
    const base = {
      cid: originalCid,
      status: "active",
      exists: true,
      active: true,
      revoked: false,
      expired: false,
    };
    expect(DelegationStatusSchema.parse(base)).toEqual(base);
    const stamp = makeStamp({ generation: 1, previousStampCid: leaseCid, newEnd: 1_750_000_000 });
    expect(DelegationStatusSchema.parse({
      ...base,
      effective_expiry: 1_750_000_000,
      renewal_history: [stamp],
    })).toMatchObject({
      effective_expiry: 1_750_000_000,
      renewal_history: [{ cid: stamp.cid, signed_bytes: stamp.signed_bytes }],
    });
  });
});
