import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { SiweMessage } from "siwe";
import { bytesToHex } from "viem";
import { decodeBase64Url } from "../credentials/digest";
import { verifyEip191MessageSignature } from "../identity";

type ReCapAttenuation = Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;

/** A wallet-signed SIWE CACAO whose encoding, signature and exact-bytes CID were verified. */
export interface SignedSiweCacao {
  readonly cid: string;
  /** Signer, `did:pkh:eip155:<chain>:<address>`. */
  readonly issuer: string;
  /** SIWE `uri`: the delegate DID, or `ucan:<cid>` for a revocation. */
  readonly audience: string;
  /** The ReCap (last SIWE resource) attenuation, checked against the statement. Null-prototype maps. */
  readonly attenuation: ReCapAttenuation;
  /** SIWE `Expiration Time` as signed. Reported only: the caller decides whether it matters. */
  readonly expiresAt?: string;
  /** SIWE `Not Before` as signed. Reported only, like `expiresAt`. */
  readonly notBefore?: string;
}

/** Real CACAOs are a few KiB; a ReCap with many resources stays far below this. */
const MAX_CACAO_BYTES = 64 * 1024;
const MAX_CBOR_DEPTH = 64;
const RECAP_PREFIX = "urn:recap:";
const RECAP_STATEMENT = "I further authorize the stated URI to perform the following actions on my behalf:";

type CborMap = Record<string, unknown>;

/** DAG-CBOR map key order: shorter encoded key first, then bytewise. */
function compareKeys(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

/** Decode the DAG-CBOR subset a CACAO uses (integers, text, bytes, arrays, string-keyed maps, booleans, null). */
function decodeDagCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new Error("CBOR input ended early");
    return bytes.subarray(offset, offset += length);
  };
  const read = (depth: number): unknown => {
    if (depth > MAX_CBOR_DEPTH) throw new Error(`CBOR nesting exceeds ${MAX_CBOR_DEPTH} levels`);
    const [initial] = take(1);
    const major = initial! >> 5;
    const info = initial! & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("CBOR floats and other simple values are not part of a CACAO");
    }
    if (major === 6) throw new Error("CBOR tags are not part of a CACAO");
    let argument: number;
    if (info < 24) argument = info;
    else if (info === 24) argument = take(1)[0]!;
    else if (info === 25) argument = view.getUint16(take(2).byteOffset - bytes.byteOffset);
    else if (info === 26) argument = view.getUint32(take(4).byteOffset - bytes.byteOffset);
    else if (info === 27) {
      const value = view.getBigUint64(take(8).byteOffset - bytes.byteOffset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer is too large");
      argument = Number(value);
    } else throw new Error("CBOR indefinite lengths are not DAG-CBOR");
    switch (major) {
      case 0: return argument;
      case 1: return -1 - argument;
      case 2: return take(argument).slice();
      case 3: return new TextDecoder("utf-8", { fatal: true }).decode(take(argument));
      case 4: {
        if (argument > bytes.length - offset) throw new Error("CBOR input ended early");
        const items: unknown[] = [];
        for (let index = 0; index < argument; index++) items.push(read(depth + 1));
        return items;
      }
      default: {
        if (argument > bytes.length - offset) throw new Error("CBOR input ended early");
        const map: CborMap = Object.create(null);
        for (let index = 0; index < argument; index++) {
          const key = read(depth + 1);
          if (typeof key !== "string") throw new Error("CBOR map keys must be strings");
          if (key === "__proto__") throw new Error("CBOR map key __proto__ is not allowed");
          if (Object.prototype.hasOwnProperty.call(map, key)) throw new Error(`CBOR map has a duplicate key ${JSON.stringify(key)}`);
          map[key] = read(depth + 1);
        }
        return map;
      }
    }
  };
  const value = read(0);
  if (offset !== bytes.length) throw new Error("CBOR input has trailing bytes");
  return value;
}

/** Canonical DAG-CBOR: minimal heads, definite lengths, map keys ordered by encoded length then bytes. */
export function encodeDagCbor(value: unknown): Uint8Array {
  const output: number[] = [];
  const head = (major: number, argument: number): void => {
    if (argument < 24) output.push((major << 5) | argument);
    else if (argument < 0x100) output.push((major << 5) | 24, argument);
    else if (argument < 0x10000) output.push((major << 5) | 25, argument >> 8, argument & 0xff);
    else if (argument < 0x100000000) output.push((major << 5) | 26, ...[24, 16, 8, 0].map((shift) => (argument >>> shift) & 0xff));
    else output.push((major << 5) | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((shift) => Number((BigInt(argument) >> shift) & 0xffn)));
  };
  const write = (item: unknown): void => {
    if (item === null) output.push(0xf6);
    else if (item === false) output.push(0xf4);
    else if (item === true) output.push(0xf5);
    else if (typeof item === "number" && Number.isSafeInteger(item)) {
      if (item >= 0) head(0, item); else head(1, -1 - item);
    } else if (typeof item === "string") {
      const encoded = new TextEncoder().encode(item);
      head(3, encoded.length);
      output.push(...encoded);
    } else if (item instanceof Uint8Array) {
      head(2, item.length);
      output.push(...item);
    } else if (Array.isArray(item)) {
      head(4, item.length);
      item.forEach(write);
    } else if (typeof item === "object") {
      const entries = Object.keys(item).map((key) => [new TextEncoder().encode(key), (item as CborMap)[key]] as const);
      entries.sort(([left], [right]) => compareKeys(left, right));
      head(5, entries.length);
      for (const [key, entry] of entries) {
        head(3, key.length);
        output.push(...key);
        write(entry);
      }
    } else throw new Error("value is not DAG-CBOR encodable");
  };
  write(value);
  return Uint8Array.from(output);
}

function map(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []): CborMap {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`CACAO ${label} must be a map`);
  const entries = value as CborMap;
  for (const key of Object.keys(entries)) {
    if (!keys.includes(key) && !optional.includes(key)) throw new Error(`CACAO ${label} has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of keys) if (!(key in entries)) throw new Error(`CACAO ${label} is missing ${key}`);
  return entries;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`CACAO ${label} must be a non-empty string`);
  return value;
}

/** The statement suffix a ReCap requires (siwe-recap `Capability::to_statement`). */
function reCapStatement(attenuation: ReCapAttenuation): string {
  let index = 0;
  let lines = "";
  for (const resource of Object.keys(attenuation).sort()) {
    const namespaces: Record<string, string[]> = Object.create(null);
    for (const ability of Object.keys(attenuation[resource]!).sort()) {
      const slash = ability.indexOf("/");
      if (slash <= 0) throw new Error("ReCap ability must be namespace/name");
      (namespaces[ability.slice(0, slash)] ??= []).push(ability.slice(slash + 1));
    }
    for (const namespace of Object.keys(namespaces).sort()) {
      lines += ` (${++index}) '${namespace}': ${namespaces[namespace]!.map((name) => `'${name}'`).join(", ")} for '${resource}'.`;
    }
  }
  return `${RECAP_STATEMENT}${lines}`;
}

/** Parse a ReCap resource into resource -> ability -> non-empty caveat-object list. */
function reCapAttenuation(resource: string): ReCapAttenuation {
  const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(resource.slice(RECAP_PREFIX.length))));
  if (!isObject(parsed) || !("att" in parsed) || !isObject(parsed.att)) throw new Error("ReCap attenuation must be an object");
  const attenuation: Record<string, Record<string, readonly unknown[]>> = Object.create(null);
  for (const [target, abilities] of Object.entries(parsed.att)) {
    if (target === "__proto__" || !isObject(abilities) || Object.keys(abilities).length === 0) throw new Error("ReCap resource must map to abilities");
    const copy: Record<string, readonly unknown[]> = Object.create(null);
    for (const [ability, caveats] of Object.entries(abilities)) {
      if (ability === "__proto__" || !/^[^/]+\/[^/]/.test(ability)) throw new Error("ReCap ability must be namespace/name");
      if (!Array.isArray(caveats) || caveats.length === 0 || !caveats.every(isObject)) throw new Error("ReCap caveats must be a non-empty array of objects");
      copy[ability] = caveats;
    }
    attenuation[target] = copy;
  }
  return attenuation;
}

/**
 * Verify a base64url DAG-CBOR SIWE CACAO (a wallet-signed delegation or
 * revocation) and return what it signs. Checks: size and nesting limits, the
 * exact-bytes CID, canonical DAG-CBOR (so one signature has one CID), the
 * CACAO shape, the ReCap statement, and the EIP-191 signature over the
 * EIP-4361 message rebuilt from the payload, against the `did:pkh` issuer.
 * Throws when any check fails.
 *
 * Validity times are not checked: `expiresAt` is reported for the caller to
 * judge, and `Not Before` is only covered by the signature.
 */
export async function parseSignedSiweCacao(authorization: string, expectedCid?: string): Promise<SignedSiweCacao> {
  if (authorization.length > Math.ceil(MAX_CACAO_BYTES / 3) * 4 + 2) throw new Error(`CACAO exceeds ${MAX_CACAO_BYTES} bytes`);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(authorization)) throw new Error("CACAO must be base64url DAG-CBOR");
  const bytes = decodeBase64Url(authorization.replace(/=+$/, ""));
  if (bytes.length > MAX_CACAO_BYTES) throw new Error(`CACAO exceeds ${MAX_CACAO_BYTES} bytes`);
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
  if (expectedCid !== undefined && cid !== expectedCid) throw new Error("CACAO CID does not match exact Authorization bytes");
  const decoded = decodeDagCbor(bytes);
  const canonical = encodeDagCbor(decoded);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error("CACAO is not canonical DAG-CBOR");

  const cacao = map(decoded, "envelope", ["h", "p", "s"]);
  if (map(cacao.h, "header", ["t"]).t !== "eip4361") throw new Error("CACAO header must be eip4361");
  const signature = map(cacao.s, "signature", ["t", "s"]);
  if (signature.t !== "eip191" || !(signature.s instanceof Uint8Array) || signature.s.length !== 65) throw new Error("CACAO signature must be a 65-byte eip191 signature");
  const payload = map(cacao.p, "payload", ["domain", "iss", "aud", "version", "nonce", "iat"], ["exp", "nbf", "statement", "requestId", "resources"]);
  if (payload.version !== 1) throw new Error("CACAO SIWE version must be the integer 1");
  const issuer = text(payload.iss, "iss");
  // The chain ID must survive the number conversion the SIWE message uses.
  const pkh = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(issuer);
  const chainId = Number(pkh?.[1]);
  if (pkh === null || !Number.isSafeInteger(chainId) || String(chainId) !== pkh[1]) throw new Error("CACAO issuer must be did:pkh:eip155 with a safe-integer chain ID");
  const audience = text(payload.aud, "aud");
  const optional = (key: string): string | undefined => payload[key] === undefined ? undefined : text(payload[key], key);
  const statement = optional("statement");
  const expiresAt = optional("exp");
  const notBefore = optional("nbf");
  const requestId = optional("requestId");
  let resources: string[] = [];
  if ("resources" in payload) {
    if (!Array.isArray(payload.resources) || payload.resources.length === 0) throw new Error("CACAO resources must be a non-empty array when present");
    resources = payload.resources.map((resource, index) => text(resource, `resources[${index}]`));
  }

  const last = resources.at(-1);
  const attenuation: ReCapAttenuation = last?.startsWith(RECAP_PREFIX) ? reCapAttenuation(last) : Object.create(null);
  if (last?.startsWith(RECAP_PREFIX) && !statement?.endsWith(reCapStatement(attenuation))) throw new Error("CACAO statement does not match its ReCap");

  const message = new SiweMessage({
    domain: text(payload.domain, "domain"),
    address: pkh[2]!,
    uri: audience,
    version: "1",
    chainId,
    nonce: text(payload.nonce, "nonce"),
    issuedAt: text(payload.iat, "iat"),
    ...(statement === undefined ? {} : { statement }),
    ...(expiresAt === undefined ? {} : { expirationTime: expiresAt }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(resources.length === 0 ? {} : { resources }),
  }).prepareMessage();
  if (!await verifyEip191MessageSignature(message, bytesToHex(signature.s), pkh[2]!)) throw new Error("CACAO signature is invalid");
  return { cid, issuer, audience, attenuation, ...(expiresAt === undefined ? {} : { expiresAt }), ...(notBefore === undefined ? {} : { notBefore }) };
}
