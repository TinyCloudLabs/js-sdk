import { signCompactUcanAuthorization, toBase64Url } from "@tinycloud/share-envelope";
import { keccak_256 } from "@noble/hashes/sha3";
import { ownerRootCacaoCid } from "./owner-root-cacao.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "./owner-policy.js";
import { NETWORK_REVOKE_ABILITY, nodeDidOf, parseOwnerNetworkUrn, retireShareNetwork } from "./share-network.js";
import { ShareRootError, errorMessage, parseOwnerDid, requireNodeOrigin, sameOwner, seconds, type Owner } from "./share-root.js";

/**
 * Largest `Authorization` value an owner control may carry. Measured on the
 * production ingress (nginx 1.27.4, `large_client_header_buffers 4 32k`,
 * HTTP/1.1): 32,751 bytes pass, 32,752 bytes get `400 Request Header Or
 * Cookie Too Large`. A direct Node accepts ~483 KB and Cloudflare 128 KB.
 * 30,000 bytes leave 8.4% for header-name and proxy overhead. Each share
 * (network URN with `delegation/revoke` + `network.revoke`) costs ~845
 * bytes: 34 shares per control with the space rows (29,800 bytes measured
 * with the `applications` row, imported by the Node), 35 without.
 */
export const SHARE_CONTROL_HEADER_BUDGET_BYTES = 30_000;
/** A control lives ten minutes: long enough to retire and revoke one batch. */
export const SHARE_CONTROL_LIFETIME_MS = 10 * 60_000;
const DELEGATION_REVOKE_ABILITY = "tinycloud.delegation/revoke";
const RECAP_STATEMENT = "I further authorize the stated URI to perform the following actions on my behalf:";
/** Every Ed25519 did:key has this length, so a plan can size the control before the key exists. */
const PLACEHOLDER_KEY_DID = `did:key:z6Mk${"1".repeat(44)}`;

type FetchFn = (input: URL, init?: RequestInit) => Promise<Response>;
type Attenuation = Record<string, Record<string, readonly Record<string, never>[]>>;

/** The owner wallet, as a SIWE signer: one call = one approval. */
export interface ShareControlOwner {
  /** `did:pkh:eip155:<chain>:<address>`. */
  readonly ownerDid: string;
  /** The SIWE `domain` the wallet shows (the composer's host). */
  readonly domain: string;
  /** EIP-191 `personal_sign` of exactly `message`; returns the 65-byte signature as 0x hex. */
  signMessage(message: string): Promise<string>;
}

/** One share to cut: its network, and its grant when known. */
export interface ShareControlTarget {
  readonly networkId: string;
  readonly grantCid?: string;
}

/** One owner control: one approval, sized to the header budget before signing. */
export interface ShareControlBatch {
  readonly targets: readonly ShareControlTarget[];
  /** `<space>/delegation` rows (first batch only): revoke any delegation in those spaces (share roots, links). */
  readonly spaceDelegationResources: readonly string[];
  /** Exact `Authorization` value length of the signed control, in bytes. */
  readonly headerBytes: number;
}

function checksumAddress(address: string): string {
  const lower = address.toLowerCase().slice(2);
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let index = 0; index < lower.length; index++) {
    const nibble = (hash[index >> 1]! >> (index % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? lower[index]!.toUpperCase() : lower[index]!;
  }
  return out;
}

/** The statement suffix a ReCap requires (siwe-recap `Capability::to_statement`), as sdk-core verifies it. */
function reCapStatement(attenuation: Attenuation): string {
  let index = 0;
  let lines = "";
  for (const resource of Object.keys(attenuation).sort()) {
    const namespaces: Record<string, string[]> = {};
    for (const ability of Object.keys(attenuation[resource]!).sort()) {
      const slash = ability.indexOf("/");
      (namespaces[ability.slice(0, slash)] ??= []).push(ability.slice(slash + 1));
    }
    for (const namespace of Object.keys(namespaces).sort()) {
      lines += ` (${++index}) '${namespace}': ${namespaces[namespace]!.map((name) => `'${name}'`).join(", ")} for '${resource}'.`;
    }
  }
  return `${RECAP_STATEMENT}${lines}`;
}

/** Canonical DAG-CBOR for the CACAO subset: text, safe integers, bytes, arrays, string-keyed maps. */
function encodeDagCbor(value: unknown): Uint8Array {
  const output: number[] = [];
  const head = (major: number, argument: number): void => {
    if (argument < 24) output.push((major << 5) | argument);
    else if (argument < 0x100) output.push((major << 5) | 24, argument);
    else if (argument < 0x10000) output.push((major << 5) | 25, argument >> 8, argument & 0xff);
    else output.push((major << 5) | 26, (argument >>> 24) & 0xff, (argument >>> 16) & 0xff, (argument >>> 8) & 0xff, argument & 0xff);
  };
  const write = (item: unknown): void => {
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item < 0x100000000) head(0, item);
    else if (typeof item === "string") {
      const encoded = new TextEncoder().encode(item);
      head(3, encoded.length);
      output.push(...encoded);
    } else if (item instanceof Uint8Array) {
      head(2, item.length);
      output.push(...item);
    } else if (Array.isArray(item)) {
      head(4, item.length);
      item.forEach(write);
    } else if (typeof item === "object" && item !== null) {
      const entries = Object.entries(item).map(([key, entry]) => [new TextEncoder().encode(key), entry] as const);
      entries.sort(([left], [right]) => left.length - right.length || compareBytes(left, right));
      head(5, entries.length);
      for (const [key, entry] of entries) {
        head(3, key.length);
        output.push(...key);
        write(entry);
      }
    } else throw new Error("value is not encodable as a CACAO field");
  };
  write(value);
  return Uint8Array.from(output);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

interface UnsignedControl {
  readonly message: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The owner control as an EIP-4361 message and CACAO payload: one ReCap
 * granting `tinycloud.delegation/revoke` and `network.revoke` on each target
 * network, plus `delegation/revoke` on each space row, to `keyDid`.
 */
function unsignedControl(input: { owner: Owner; domain: string; keyDid: string; attenuation: Attenuation; issuedAt: string; expiresAt: string; nonce: string }): UnsignedControl {
  const address = checksumAddress(input.owner.address);
  const statement = reCapStatement(input.attenuation);
  const recap = `urn:recap:${toBase64Url(new TextEncoder().encode(JSON.stringify({ att: input.attenuation, prf: [] })))}`;
  const message = [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${input.keyDid}`,
    "Version: 1",
    `Chain ID: ${input.owner.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
    "Resources:",
    `- ${recap}`,
  ].join("\n");
  const payload = { aud: input.keyDid, domain: input.domain, exp: input.expiresAt, iat: input.issuedAt, iss: `did:pkh:eip155:${input.owner.chainId}:${address}`, nonce: input.nonce, resources: [recap], statement, version: 1 };
  return { message, payload };
}

function signedControlBytes(payload: Record<string, unknown>, signature: Uint8Array): Uint8Array {
  return encodeDagCbor({ h: { t: "eip4361" }, p: payload, s: { t: "eip191", s: signature } });
}

function attenuationFor(targets: readonly ShareControlTarget[], spaceDelegationResources: readonly string[]): Attenuation {
  const attenuation: Attenuation = {};
  for (const resource of spaceDelegationResources) attenuation[resource] = { [DELEGATION_REVOKE_ABILITY]: [{}] };
  for (const target of targets) attenuation[target.networkId] = { [DELEGATION_REVOKE_ABILITY]: [{}], [NETWORK_REVOKE_ABILITY]: [{}] };
  return attenuation;
}

const ISO_PLACEHOLDER = new Date(0).toISOString();
const NONCE_PLACEHOLDER = "0".repeat(32);

/**
 * The `Authorization` value of a signed control: PADDED base64url, as the
 * WASM signer sends it. Released Nodes refuse an unpadded value whose length
 * is not a multiple of 4 (measured: 401 from the header guard).
 */
function headerValue(bytes: Uint8Array): string {
  const text = toBase64Url(bytes);
  return text + "=".repeat((4 - (text.length % 4)) % 4);
}

function headerLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function headerBytesOf(owner: Owner, domain: string, targets: readonly ShareControlTarget[], spaceDelegationResources: readonly string[]): number {
  const { payload } = unsignedControl({ owner, domain, keyDid: PLACEHOLDER_KEY_DID, attenuation: attenuationFor(targets, spaceDelegationResources), issuedAt: ISO_PLACEHOLDER, expiresAt: ISO_PLACEHOLDER, nonce: NONCE_PLACEHOLDER });
  return headerLength(signedControlBytes(payload, new Uint8Array(65)).length);
}

/**
 * Split a kill-all into owner controls (one approval each), sized by the
 * exact `Authorization` bytes of each signed control, never above
 * `budgetBytes` (default {@link SHARE_CONTROL_HEADER_BUDGET_BYTES}). The
 * first batch also carries `<space>/delegation` for each of `spaceIds`.
 * `createOwnerDelegation` cannot express these rows (and caps a delegation
 * at 16 permissions), so controls are built here.
 */
export function planShareControlBatches(input: {
  readonly owner: Pick<ShareControlOwner, "ownerDid" | "domain">;
  readonly targets: readonly ShareControlTarget[];
  /** Spaces whose delegations the first control may revoke (e.g. the owner's `applications` and `default`). */
  readonly spaceIds?: readonly string[];
  readonly budgetBytes?: number;
}): ShareControlBatch[] {
  const owner = parseOwnerDid(input.owner.ownerDid);
  const budget = input.budgetBytes ?? SHARE_CONTROL_HEADER_BUDGET_BYTES;
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > SHARE_CONTROL_HEADER_BUDGET_BYTES) throw new ShareRootError("invalid-request", `control budget must be 1..${SHARE_CONTROL_HEADER_BUDGET_BYTES} bytes`);
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(input.owner.domain)) throw new ShareRootError("invalid-request", "control domain must be a host");
  const spaceRows = (input.spaceIds ?? []).map((spaceId) => {
    const match = /^tinycloud:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):([A-Za-z0-9_-]+)$/.exec(spaceId);
    if (match === null || !sameOwner({ chainId: match[1]!, address: match[2]!.toLowerCase() }, owner)) throw new ShareRootError("invalid-request", "control spaces must be the owner's");
    return `${spaceId}/delegation`;
  });
  const seen = new Set<string>();
  for (const target of input.targets) {
    const network = parseOwnerNetworkUrn(target.networkId);
    if (network === undefined || !sameOwner(network.owner, owner)) throw new ShareRootError("invalid-request", "control targets must be the owner's networks");
    if (seen.has(target.networkId)) throw new ShareRootError("invalid-request", "control targets must not repeat a network");
    seen.add(target.networkId);
  }

  const batches: ShareControlBatch[] = [];
  let current: ShareControlTarget[] = [];
  let rows = spaceRows;
  let size = rows.length === 0 ? 0 : headerBytesOf(owner, input.owner.domain, [], rows);
  if (size > budget) throw new ShareRootError("invalid-request", "the space rows alone exceed the control budget");
  for (const target of input.targets) {
    const next = headerBytesOf(owner, input.owner.domain, [...current, target], rows);
    if (next <= budget) {
      current.push(target);
      size = next;
      continue;
    }
    if (current.length === 0 && rows.length === 0) throw new ShareRootError("invalid-request", "one target exceeds the control budget");
    batches.push({ targets: current, spaceDelegationResources: rows, headerBytes: size });
    rows = [];
    current = [target];
    size = headerBytesOf(owner, input.owner.domain, current, rows);
    if (size > budget) throw new ShareRootError("invalid-request", "one target exceeds the control budget");
  }
  if (current.length > 0 || rows.length > 0) batches.push({ targets: current, spaceDelegationResources: rows, headerBytes: size });
  return batches;
}

function signatureBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new ShareRootError("invalid-request", "owner signature must be 65 bytes of 0x hex");
  const bytes = new Uint8Array(65);
  for (let index = 0; index < 65; index++) bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return bytes;
}

export interface ShareControlResult {
  readonly controlCid: string;
  readonly networks: readonly { readonly networkId: string; readonly result: "retired" | "absent" | "failed"; readonly error?: string }[];
  /**
   * `revoked`: by the control. `revoked-by-owner`: the Node refused the
   * control (released Nodes refuse it for grants that carry decrypt) and
   * the per-grant owner fallback (one approval each) revoked it. `refused`:
   * still live.
   */
  readonly grants: readonly { readonly grantCid: string; readonly result: "revoked" | "revoked-by-owner" | "refused"; readonly status: number }[];
}

/**
 * Run one planned control (one approval): sign it to a fresh throwaway key,
 * import it (`POST /delegate`), retire EVERY target network first (decrypt
 * is cut for everyone at the next request), then revoke each known grant
 * through the control. With `revokeFallback`, a grant the Node refuses to
 * revoke through the control is revoked by the owner directly (one approval
 * each). The throwaway key is cleared before returning.
 */
export async function runShareControlBatch(input: {
  readonly owner: ShareControlOwner;
  readonly nodeOrigin: string;
  readonly batch: ShareControlBatch;
  readonly revokeFallback?: { signOwnerRevocation(cid: string): Promise<string> };
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly keyFactory?: () => Promise<DelegatedShareKey>;
}): Promise<ShareControlResult> {
  const fetchFn: FetchFn = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const clock = input.now ?? Date.now;
  const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
  const owner = parseOwnerDid(input.owner.ownerDid);
  const { batch } = input;
  const key = await (input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))();
  try {
    const now = clock();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + SHARE_CONTROL_LIFETIME_MS).toISOString();
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const control = unsignedControl({ owner, domain: input.owner.domain, keyDid: key.did, attenuation: attenuationFor(batch.targets, batch.spaceDelegationResources), issuedAt, expiresAt, nonce });
    const sized = headerLength(signedControlBytes(control.payload, new Uint8Array(65)).length);
    if (sized > SHARE_CONTROL_HEADER_BUDGET_BYTES) throw new ShareRootError("invalid-request", `control is ${sized} bytes, above the ${SHARE_CONTROL_HEADER_BUDGET_BYTES}-byte budget`);
    const bytes = signedControlBytes(control.payload, signatureBytes(await input.owner.signMessage(control.message)));
    const controlCid = ownerRootCacaoCid(bytes);
    const imported = await fetchFn(new URL("/delegate", nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: headerValue(bytes) } });
    if (!imported.ok) throw new ShareRootError("node-refused", `owner control import failed: HTTP ${imported.status} ${(await imported.text()).slice(0, 120)}`);
    await imported.body?.cancel();

    const nodeDid = await nodeDidOf(nodeOrigin, fetchFn);
    const signer = { did: key.did, sign: (data: Uint8Array) => key.sign(data) };
    const networks: ShareControlResult["networks"][number][] = [];
    for (const target of batch.targets) {
      try {
        networks.push({ networkId: target.networkId, result: await retireShareNetwork({ nodeOrigin, nodeDid, networkId: target.networkId, signer, proof: controlCid, fetch: fetchFn, now: clock }) });
      } catch (error) {
        networks.push({ networkId: target.networkId, result: "failed", error: errorMessage(error) });
      }
    }
    const grants: ShareControlResult["grants"][number][] = [];
    for (const target of batch.targets) {
      if (target.grantCid === undefined) continue;
      const at = seconds(clock());
      const invocation = await signCompactUcanAuthorization({
        issuerDid: key.did,
        audienceDid: key.did,
        attenuation: { [`urn:cid:${target.grantCid}`]: { [DELEGATION_REVOKE_ABILITY]: [{}] } },
        facts: [{}],
        proofs: [controlCid],
        notBefore: at,
        expiresAt: at + 60,
        nonce: `urn:uuid:${crypto.randomUUID()}`,
        sign: signer.sign,
      });
      const response = await fetchFn(new URL("/revoke", nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: invocation.authorization } });
      await response.body?.cancel();
      if (response.ok) {
        grants.push({ grantCid: target.grantCid, result: "revoked", status: response.status });
        continue;
      }
      if (input.revokeFallback === undefined) {
        grants.push({ grantCid: target.grantCid, result: "refused", status: response.status });
        continue;
      }
      const fallback = await fetchFn(new URL("/revoke", nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: await input.revokeFallback.signOwnerRevocation(target.grantCid) } });
      await fallback.body?.cancel();
      grants.push({ grantCid: target.grantCid, result: fallback.ok ? "revoked-by-owner" : "refused", status: fallback.status });
    }
    return { controlCid, networks, grants };
  } finally {
    key.clear();
  }
}
