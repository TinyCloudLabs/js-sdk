import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { SiweMessage } from "siwe";
import { bytesToHex } from "viem";
import { decodeBase64Url } from "../credentials/digest";
import { verifyEip191MessageSignature } from "../identity";

/** A wallet-signed SIWE CACAO whose signature and exact-bytes CID were verified. */
export interface SignedSiweCacao {
  readonly cid: string;
  /** Signer, `did:pkh:eip155:<chain>:<address>`. */
  readonly issuer: string;
  /** SIWE `uri`: the delegate DID, or `ucan:<cid>` for a revocation. */
  readonly audience: string;
  /** ReCap attenuation from the SIWE `urn:recap:` resources, merged by resource. */
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  readonly expiresAt?: string;
}

/** Decode the DAG-CBOR subset a CACAO uses: integers, strings, bytes, arrays, maps, booleans, null. */
function decodeDagCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (): unknown => {
    if (offset >= bytes.length) throw new Error("CBOR input ended early");
    const initial = bytes[offset++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    let length: number;
    if (info < 24) length = info;
    else if (info === 24) length = bytes[offset++]!;
    else if (info === 25) { length = view.getUint16(offset); offset += 2; }
    else if (info === 26) { length = view.getUint32(offset); offset += 4; }
    else if (info === 27) {
      const value = view.getBigUint64(offset);
      offset += 8;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer is too large");
      length = Number(value);
    } else throw new Error("CBOR indefinite lengths are not DAG-CBOR");
    switch (major) {
      case 0: return length;
      case 1: return -1 - length;
      case 2: {
        if (offset + length > bytes.length) throw new Error("CBOR input ended early");
        return bytes.slice(offset, offset += length);
      }
      case 3: {
        if (offset + length > bytes.length) throw new Error("CBOR input ended early");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset += length));
      }
      case 4: return Array.from({ length }, read);
      case 5: {
        const map: Record<string, unknown> = {};
        for (let index = 0; index < length; index++) {
          const key = read();
          if (typeof key !== "string") throw new Error("CBOR map keys must be strings");
          map[key] = read();
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("unsupported CBOR simple value");
      default: throw new Error("CBOR tags are not part of a CACAO");
    }
  };
  const value = read();
  if (offset !== bytes.length) throw new Error("CBOR input has trailing bytes");
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`CACAO ${label} must be a map`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`CACAO ${label} must be a string`);
  return value;
}

/**
 * Verify a base64url DAG-CBOR SIWE CACAO (a wallet-signed delegation or
 * revocation): its CID over the exact bytes, its EIP-4361 message rebuilt
 * from the payload, and the EIP-191 signature against the `did:pkh` issuer.
 * Throws when any check fails.
 */
export async function parseSignedSiweCacao(authorization: string, expectedCid?: string): Promise<SignedSiweCacao> {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(authorization)) throw new Error("CACAO must be base64url DAG-CBOR");
  const bytes = decodeBase64Url(authorization.replace(/=+$/, ""));
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
  if (expectedCid !== undefined && cid !== expectedCid) throw new Error("CACAO CID does not match exact Authorization bytes");
  const cacao = record(decodeDagCbor(bytes), "envelope");
  if (record(cacao.h, "header").t !== "eip4361") throw new Error("CACAO header must be eip4361");
  const signature = record(cacao.s, "signature");
  if (signature.t !== "eip191" || !(signature.s instanceof Uint8Array)) throw new Error("CACAO signature must be eip191");
  const payload = record(cacao.p, "payload");
  const issuer = optionalString(payload.iss, "iss");
  const pkh = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(issuer ?? "");
  if (issuer === undefined || pkh === null) throw new Error("CACAO issuer must be did:pkh:eip155");
  const audience = optionalString(payload.aud, "aud");
  const domain = optionalString(payload.domain, "domain");
  const nonce = optionalString(payload.nonce, "nonce");
  const issuedAt = optionalString(payload.iat, "iat");
  if (audience === undefined || domain === undefined || nonce === undefined || issuedAt === undefined) throw new Error("CACAO payload is incomplete");
  if (payload.version !== 1 && payload.version !== "1") throw new Error("CACAO SIWE version must be 1");
  const resources = payload.resources === undefined ? [] : payload.resources;
  if (!Array.isArray(resources) || resources.some((resource) => typeof resource !== "string")) throw new Error("CACAO resources must be strings");
  const expiresAt = optionalString(payload.exp, "exp");
  const notBefore = optionalString(payload.nbf, "nbf");
  const statement = optionalString(payload.statement, "statement");
  const requestId = optionalString(payload.requestId, "requestId");
  const message = new SiweMessage({
    domain,
    address: pkh[2]!,
    uri: audience,
    version: "1",
    chainId: Number(pkh[1]),
    nonce,
    issuedAt,
    ...(statement === undefined ? {} : { statement }),
    ...(expiresAt === undefined ? {} : { expirationTime: expiresAt }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(resources.length === 0 ? {} : { resources: resources as string[] }),
  }).prepareMessage();
  const signatureHex = bytesToHex(signature.s);
  if (!await verifyEip191MessageSignature(message, signatureHex, pkh[2]!)) throw new Error("CACAO signature is invalid");
  const attenuation: Record<string, Record<string, readonly unknown[]>> = {};
  for (const resource of resources as string[]) {
    if (!resource.startsWith("urn:recap:")) continue;
    const recap = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(resource.slice("urn:recap:".length).replace(/=+$/, "")))), "ReCap");
    for (const [target, actions] of Object.entries(record(recap.att, "ReCap attenuation"))) {
      attenuation[target] = { ...attenuation[target], ...(record(actions, "ReCap actions") as Record<string, readonly unknown[]>) };
    }
  }
  return { cid, issuer, audience, attenuation, ...(expiresAt === undefined ? {} : { expiresAt }) };
}
