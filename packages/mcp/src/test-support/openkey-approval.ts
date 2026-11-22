import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  openLinkRecord,
  parseLink,
  type LinkRecord,
  type OpenKeyApprovalRequestV1,
} from "@tinycloud/share-envelope/links";
import {
  NodeWasmBindings,
  PrivateKeySigner,
  TinyCloudNode,
  siweRuntimeDelegation,
  type PortableDelegation,
} from "@tinycloud/node-sdk";

/** Wallets used as OpenKey principals in hosted MCP tests. */
export const REQUESTER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
export const OTHER_OWNER_KEY = "6c875bfb4f247fcbcd37fd56f564fca0cfaf6458cd5e8878e9ef32ecdc9cfd5b";

/** The fake OpenKey's origins; hosted test configs name them. */
export const OPENKEY_ORIGIN = "https://openkey.test";
export const OPENKEY_API_ORIGIN = "https://api.openkey.test";
export const LINKS_API_ORIGIN = "https://links.openkey.test";

/** Result retention the fake answers with, as OpenKey's production setting. */
const RESULT_RETENTION_MS = 600_000;

export async function ownerDid(privateKey: string): Promise<string> {
  const signer = new PrivateKeySigner(privateKey);
  return `did:pkh:eip155:${await signer.getChainId()}:${await signer.getAddress()}`;
}

export async function ownerSpace(privateKey: string, name: string): Promise<string> {
  const signer = new PrivateKeySigner(privateKey);
  return new NodeWasmBindings().makeSpaceId(await signer.getAddress(), await signer.getChainId(), name);
}

/**
 * Project an OpenKey delegation into the portable delegation an importer
 * would build, verified against the tenant's key, without going through the store.
 */
export async function siweDelegationFromApproval(
  body: Record<string, unknown>,
  tenantStateRoot: string,
  host: string,
): Promise<PortableDelegation> {
  const header = body.delegationHeader;
  if (typeof header !== "object" || header === null || !("Authorization" in header) ||
    typeof header.Authorization !== "string" || typeof body.delegationCid !== "string" ||
    typeof body.spaceId !== "string" || typeof body.verificationMethod !== "string" ||
    typeof body.address !== "string" || typeof body.chainId !== "number" ||
    typeof body.siwe !== "string" || typeof body.signature !== "string") {
    throw new Error("Approval delegation is incomplete.");
  }
  const jwk = JSON.parse(await readFile(
    join(tenantStateRoot, ".tinycloud/profiles/agent/key.json"),
    "utf8",
  )) as Record<string, unknown>;
  const node = new TinyCloudNode({ host });
  await node.restoreSession({
    delegationHeader: { Authorization: header.Authorization },
    delegationCid: body.delegationCid,
    spaceId: body.spaceId,
    jwk,
    verificationMethod: body.verificationMethod,
    address: body.address,
    chainId: body.chainId,
    siwe: body.siwe,
    signature: body.signature,
  });
  return siweRuntimeDelegation(node, {
    authorization: header.Authorization,
    cid: body.delegationCid,
    spaceId: body.spaceId,
    ownerAddress: body.address,
    chainId: body.chainId,
    siwe: body.siwe,
    signature: body.signature,
    host,
  });
}

/**
 * The delegation an OpenKey approval result carries: a SIWE session for the
 * tenant's hosted delegate key, signed by `privateKey`.
 */
export async function openKeyDelegation(options: {
  readonly tenantStateRoot: string;
  readonly privateKey: string;
  readonly space: string;
  readonly abilities: Record<string, Record<string, string[]>>;
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
}): Promise<Record<string, unknown>> {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(options.privateKey);
  const jwk = JSON.parse(await readFile(
    join(options.tenantStateRoot, ".tinycloud/profiles/agent/key.json"),
    "utf8",
  )) as Record<string, unknown>;
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const now = options.issuedAt?.getTime() ?? Date.now();
  const expiry = (options.expiresAt ?? new Date(now + 60 * 60_000)).toISOString();
  const spaceId = wasm.makeSpaceId(address, chainId, options.space);
  const prepared = wasm.prepareSession({
    abilities: options.abilities,
    address,
    chainId,
    domain: "openkey.test",
    issuedAt: new Date(now).toISOString(),
    expirationTime: expiry,
    spaceId,
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    verificationMethod: session.verificationMethod,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiry,
    requestedSpaces: [spaceId],
  };
}

/**
 * Approve a request the way OpenKey does: sign exactly the requested
 * permissions, all in one space, which OpenKey re-derives from the signer's
 * address and the space name.
 */
export async function openKeyApprovalDelegation(options: {
  readonly request: OpenKeyApprovalRequestV1;
  readonly tenantStateRoot: string;
  readonly privateKey: string;
}): Promise<Record<string, unknown>> {
  const { permissions } = options.request;
  const spaces = new Set(permissions.map((permission) => permission.space.split(":").at(-1)!));
  if (spaces.size !== 1) throw new Error("OpenKey signs one space per delegation.");
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of permissions) {
    const service = permission.service.replace(/^tinycloud\./, "");
    const paths = abilities[service] ??= {};
    paths[permission.path] = [...new Set([...(paths[permission.path] ?? []), ...permission.actions])];
  }
  return openKeyDelegation({
    tenantStateRoot: options.tenantStateRoot,
    privateKey: options.privateKey,
    space: [...spaces][0]!,
    abilities,
  });
}

/** One request the fake OpenKey stored, as its approval page reads it. */
export interface StoredApprovalRequest {
  readonly id: string;
  readonly bodyCid: string;
  readonly request: OpenKeyApprovalRequestV1;
}

/** Every call the fake answered, without bodies. */
export interface FakeOpenKeyCall {
  readonly origin: string;
  readonly path: string;
}

/** What the hosted server did with an approval: stored it, or refused it at a named stage. */
export type ApprovalDelivery =
  | { readonly status: "stored" }
  | { readonly status: "rejected"; readonly stage: string; readonly code: string; readonly reason?: string; readonly detail?: string };

interface StoredResult {
  readonly resultRef: string;
  expiresAt: string;
  readonly relay: Record<string, unknown>;
  ackId?: string;
}

/**
 * OpenKey's approval service for hosted MCP tests: the links API that stores
 * signed requests, the approval page (`approve`), and the result API the
 * server collects from. Installed over `globalThis.fetch` for its own origins
 * only; every other request passes through.
 */
export class FakeOpenKey {
  readonly calls: FakeOpenKeyCall[] = [];
  readonly diagnostics: string[] = [];
  /** HTTP status the links API answers a create with; 201 stores it. */
  linksStatus = 201;
  readonly #records = new Map<string, LinkRecord>();
  readonly #results = new Map<string, StoredResult>();
  readonly #byRef = new Map<string, { readonly requestId: string; readonly bodyCid: string }>();
  /** Diagnostics logged before each approval; a refusal is looked for after its mark. */
  readonly #marks = new Map<string, number>();
  #restore: (() => void) | undefined;

  install(): this {
    const previousFetch = globalThis.fetch;
    const handle = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const origin = new URL(request.url).origin;
      if (origin === LINKS_API_ORIGIN || origin === OPENKEY_API_ORIGIN) return this.#handle(request);
      return previousFetch(input, init);
    };
    const routed = Object.assign(handle, previousFetch);
    globalThis.fetch = routed;
    const write = process.stderr.write;
    const capture = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const line of text.split("\n")) if (line.length > 0) this.diagnostics.push(line);
      return Reflect.apply(write, process.stderr, [chunk, ...rest]) as boolean;
    }) as typeof process.stderr.write;
    process.stderr.write = capture;
    this.#restore = () => {
      if (globalThis.fetch === routed) globalThis.fetch = previousFetch;
      if (process.stderr.write === capture) process.stderr.write = write;
    };
    return this;
  }

  restore(): void {
    this.#restore?.();
    this.#restore = undefined;
  }

  /** Read a stored request the way OpenKey's approval page opens a link. */
  async requestFor(link: string | URL): Promise<StoredApprovalRequest> {
    const parsed = parseLink(String(link), { trustedOrigins: [OPENKEY_ORIGIN] });
    if (parsed.form !== "short") throw new Error("Approval links are short links.");
    const record = this.#records.get(parsed.id);
    if (record === undefined) throw new Error("OpenKey has no such approval request.");
    const opened = await openLinkRecord(record, parsed.key);
    return {
      id: parsed.id,
      bodyCid: opened.header.bodyCid,
      request: opened.value as unknown as OpenKeyApprovalRequestV1,
    };
  }

  /**
   * Approve a request with `delegation`, sealing the result to the request's
   * relay key. `ownerDid` is the owner OpenKey names; it defaults to the
   * delegation's signer. A string `delegation` stands for a malformed result.
   */
  async approve(
    link: string | URL,
    delegation: Record<string, unknown> | string,
    options: { readonly ownerDid?: string } = {},
  ): Promise<StoredApprovalRequest> {
    const stored = await this.requestFor(link);
    this.#marks.set(stored.id, this.diagnostics.length);
    const { request } = stored;
    const signed: Record<string, unknown> = typeof delegation === "string" ? {} : delegation;
    const owner = options.ownerDid ?? `did:pkh:eip155:${String(signed.chainId)}:${String(signed.address)}`;
    const expiry = typeof signed.expiry === "string" ? signed.expiry : new Date(Date.now() + 3_600_000).toISOString();
    const relay = sealRelayResult(request.resultEncryptionPublicJwk, stored.id, {
      resultVersion: 1,
      requestId: stored.id,
      requestDigest: stored.bodyCid,
      requesterDid: request.issuer,
      targetDid: request.targetDid,
      ownerDid: owner,
      delegationExpiresAt: new Date(expiry).toISOString(),
      delegation,
    });
    const resultRef = randomBytes(24).toString("base64url");
    this.#results.set(stored.id, {
      resultRef,
      expiresAt: new Date(Date.now() + RESULT_RETENTION_MS).toISOString(),
      relay,
    });
    this.#byRef.set(resultRef, { requestId: stored.id, bodyCid: stored.bodyCid });
    return stored;
  }

  /** End a result's retention, as OpenKey does after ten minutes. */
  expireResult(requestId: string): void {
    const result = this.#results.get(requestId);
    if (result !== undefined) result.expiresAt = new Date(Date.now() - 1000).toISOString();
  }

  acknowledged(requestId: string): boolean {
    return this.#results.get(requestId)?.ackId !== undefined;
  }

  /** How many times the server fetched this request's result. */
  fetches(requestId: string): number {
    const ref = this.#results.get(requestId)?.resultRef;
    return this.calls.filter((call) => call.path === `/api/approval-results/${ref}/fetch`).length;
  }

  /**
   * Wait until the server stored the approval (it acknowledged the result) or
   * logged its refusal. `trigger` runs between checks, for callers that drive
   * collection with a call; the background poll drives it otherwise.
   */
  async delivery(
    requestId: string,
    trigger?: () => Promise<unknown>,
    timeoutMs = 20_000,
  ): Promise<ApprovalDelivery> {
    const seen = this.#marks.get(requestId) ?? this.diagnostics.length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await trigger?.();
      if (this.acknowledged(requestId)) return { status: "stored" };
      const refusal = this.diagnostics.slice(seen).find((line) => line.includes("approval result rejected:"));
      if (refusal !== undefined) return parseRefusal(refusal);
      if (Date.now() >= deadline) throw new Error("The hosted server neither stored nor refused the approval.");
      await Bun.sleep(trigger === undefined ? 100 : 50);
    }
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.calls.push({ origin: url.origin, path: url.pathname });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (url.origin === LINKS_API_ORIGIN) {
      if (request.method !== "POST" || url.pathname !== "/v1/links" || body === null) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (this.linksStatus !== 201) return Response.json({ error: "unavailable" }, { status: this.linksStatus });
      const record = body as unknown as LinkRecord;
      const id = linkId();
      this.#records.set(id, record);
      return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
    }
    if (request.headers.get("openkey-session-proof") === null || body === null) {
      return Response.json({ code: "invalid_proof" }, { status: 401 });
    }
    const discover = /^\/api\/approval-requests\/([a-z2-7]{26})\/result$/.exec(url.pathname);
    if (discover !== null) {
      const requestId = discover[1]!;
      const record = this.#records.get(requestId);
      if (record === undefined || body.bodyCid !== record.header.bodyCid) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }
      const result = this.#results.get(requestId);
      if (result === undefined) return new Response(null, { status: 202 });
      if (Date.parse(result.expiresAt) <= Date.now()) return Response.json({ code: "expired_result" }, { status: 410 });
      return Response.json({ resultRef: result.resultRef, expiresAt: result.expiresAt });
    }
    const action = /^\/api\/approval-results\/([A-Za-z0-9_-]{20,128})\/(fetch|ack)$/.exec(url.pathname);
    const owner = action === null ? undefined : this.#byRef.get(action[1]!);
    if (action === null || owner === undefined || body.requestId !== owner.requestId || body.bodyCid !== owner.bodyCid) {
      return Response.json({ code: "not_found" }, { status: 404 });
    }
    const result = this.#results.get(owner.requestId)!;
    if (Date.parse(result.expiresAt) <= Date.now()) return Response.json({ code: "expired_result" }, { status: 410 });
    if (action[2] === "fetch") {
      return Response.json({
        requestId: owner.requestId,
        bodyCid: owner.bodyCid,
        resultRef: result.resultRef,
        expiresAt: result.expiresAt,
        relay: result.relay,
      });
    }
    if (typeof body.ackId !== "string") return Response.json({ code: "invalid_request" }, { status: 400 });
    if (result.ackId !== undefined && result.ackId !== body.ackId) {
      return Response.json({ code: "ack_conflict" }, { status: 409 });
    }
    result.ackId = body.ackId;
    return Response.json({ ackId: body.ackId, status: "acknowledged" });
  }
}

/** Install a fake OpenKey for the caller's test; `restore` it when the test ends. */
export function installFakeOpenKey(): FakeOpenKey {
  return new FakeOpenKey().install();
}

function parseRefusal(line: string): ApprovalDelivery {
  const fields = Object.fromEntries(
    [...line.matchAll(/(stage|code|reason|detail)=(\S+)/g)].map((match) => [match[1]!, match[2]!]),
  );
  return {
    status: "rejected",
    stage: fields.stage ?? "unknown",
    code: fields.code ?? "UNKNOWN",
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
  };
}

function linkId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
}

/** Seal a result as OpenKey does: ECDH on P-256, HMAC key derivation salted with the request id, AES-256-GCM. */
function sealRelayResult(
  recipient: { readonly x: string; readonly y: string },
  requestId: string,
  plaintext: Record<string, unknown>,
): Record<string, unknown> {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([
    Buffer.from([4]),
    Buffer.from(recipient.x, "base64url"),
    Buffer.from(recipient.y, "base64url"),
  ]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const key = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const publicKey = ephemeral.getPublicKey();
  return {
    version: 1,
    algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: {
      kty: "EC",
      crv: "P-256",
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}
