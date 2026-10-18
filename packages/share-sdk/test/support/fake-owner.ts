// Synthetic owner-signed CACAOs for ShareRoot / ShareGrant / share-network tests.
import { expect } from "bun:test";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { toBase64Url } from "@tinycloud/share-envelope";
import type { CreateOwnerDelegationParams, OwnerDelegationReceipt } from "../../src/index.js";
import { ShareRootError, type ShareRootOwnerAuthority } from "../../src/share-root-entry.js";

export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
export const OWNER_DID = `did:pkh:eip155:1:${ADDRESS}`;
export const APPLICATIONS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
export const DEFAULT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
export const KV_PREFIX = `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/`;
export const SHARE_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:share`;
export const DEFAULT_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:default`;

/** Minimal DAG-CBOR encoder for synthetic CACAO fixtures (text, ints, bytes, arrays, maps). */
export function cbor(value: unknown): number[] {
  const head = (major: number, length: number): number[] =>
    length < 24 ? [(major << 5) | length] : length < 0x100 ? [(major << 5) | 24, length] : [(major << 5) | 25, length >> 8, length & 0xff];
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") { const bytes = new TextEncoder().encode(value); return [...head(3, bytes.length), ...bytes]; }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value as Record<string, unknown>);
  return [...head(5, entries.length), ...entries.flatMap(([key, entry]) => [...cbor(key), ...cbor(entry)])];
}

export const recapResource = (body: unknown) => `urn:recap:${toBase64Url(new TextEncoder().encode(JSON.stringify(body)))}`;

export interface Tamper {
  att?: (att: Record<string, Record<string, unknown[]>>) => void;
  audience?: string;
  issuer?: string;
  expiresAt?: Date;
  issuedAt?: Date;
  notBefore?: Date;
  extraResources?: string[];
  prf?: unknown[];
  cid?: string;
}

/** An owner that signs (synthetically) whatever it is asked, optionally tampered, and counts approvals. */
export function fakeOwner(tamper: Tamper = {}, now = () => Date.now()): ShareRootOwnerAuthority & { calls: CreateOwnerDelegationParams[] } {
  const calls: CreateOwnerDelegationParams[] = [];
  return {
    ownerDid: OWNER_DID,
    calls,
    async createOwnerDelegation(params) {
      calls.push(params);
      const att: Record<string, Record<string, unknown[]>> = {};
      for (const permission of params.permissions ?? []) {
        const resource = permission.service === "tinycloud.kv" ? `${params.spaceId}/kv/${permission.path}` : permission.path;
        att[resource] = Object.fromEntries(permission.actions.map((action) => [action, [{}]]));
      }
      tamper.att?.(att);
      const payload = {
        domain: "share.example",
        iss: tamper.issuer ?? OWNER_DID,
        aud: tamper.audience ?? params.delegateDid,
        version: 1,
        nonce: "n0nce",
        iat: (tamper.issuedAt ?? new Date(now())).toISOString(),
        exp: (tamper.expiresAt ?? params.expiresAt).toISOString(),
        ...(tamper.notBefore === undefined ? {} : { nbf: tamper.notBefore.toISOString() }),
        resources: [...(tamper.extraResources ?? []), recapResource({ att, prf: tamper.prf ?? [] })],
      };
      const bytes = Uint8Array.from(cbor({ h: { t: "eip4361" }, p: payload, s: { t: "eip191", s: new Uint8Array(65) } }));
      return {
        delegationCid: tamper.cid ?? CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString(),
        signedDagCbor: bytes,
        delegation: { delegateDID: params.delegateDid, spaceId: params.spaceId, path: "", actions: [], expiry: params.expiresAt },
      } satisfies OwnerDelegationReceipt;
    },
  };
}

export async function rejects(promise: Promise<unknown>, code: string): Promise<ShareRootError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ShareRootError);
  expect((error as ShareRootError).code).toBe(code as ShareRootError["code"]);
  return error as ShareRootError;
}
