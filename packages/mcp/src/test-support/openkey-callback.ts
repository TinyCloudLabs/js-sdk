import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function ownerDid(privateKey: string): Promise<string> {
  const signer = new PrivateKeySigner(privateKey);
  return `did:pkh:eip155:${await signer.getChainId()}:${await signer.getAddress()}`;
}

export async function ownerSpace(privateKey: string, name: string): Promise<string> {
  const signer = new PrivateKeySigner(privateKey);
  return new NodeWasmBindings().makeSpaceId(await signer.getAddress(), await signer.getChainId(), name);
}

/**
 * Project a callback body into the portable delegation an importer would
 * build, verified against the tenant's key, without going through the store.
 */
export async function siweDelegationFromCallback(
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
    throw new Error("Callback body is incomplete.");
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
 * The JSON body OpenKey's `/delegate` page posts to the hosted callback: a SIWE
 * session for the tenant's hosted delegate key, signed by `privateKey`.
 */
export async function openKeyCallbackBody(options: {
  readonly tenantStateRoot: string;
  readonly privateKey: string;
  readonly space: string;
  readonly abilities: Record<string, Record<string, string[]>>;
}): Promise<Record<string, unknown>> {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(options.privateKey);
  const jwk = JSON.parse(await readFile(
    join(options.tenantStateRoot, ".tinycloud/profiles/agent/key.json"),
    "utf8",
  )) as Record<string, unknown>;
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const now = Date.now();
  const expiry = new Date(now + 60 * 60_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: options.abilities,
    address,
    chainId,
    domain: "openkey.test",
    issuedAt: new Date(now).toISOString(),
    expirationTime: expiry,
    spaceId: wasm.makeSpaceId(address, chainId, options.space),
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId: prepared.spaceId,
    verificationMethod: session.verificationMethod,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiry,
  };
}

/**
 * Approve an OpenKey `/delegate` redirect the way OpenKey does: sign exactly
 * the requested permissions, all in one space, which OpenKey re-derives from
 * the signer's address and the space name.
 */
export async function openKeyApprovalBody(options: {
  readonly redirect: URL;
  readonly tenantStateRoot: string;
  readonly privateKey: string;
}): Promise<Record<string, unknown>> {
  const encoded = options.redirect.searchParams.get("permissions");
  if (encoded === null) throw new Error("OpenKey redirect has no permissions.");
  const { permissions } = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
  };
  const spaces = new Set(permissions.map((permission) => permission.space.split(":").at(-1)!));
  if (spaces.size !== 1) throw new Error("OpenKey signs one space per delegation.");
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of permissions) {
    const service = permission.service.replace(/^tinycloud\./, "");
    const paths = abilities[service] ??= {};
    paths[permission.path] = [...new Set([...(paths[permission.path] ?? []), ...permission.actions])];
  }
  return openKeyCallbackBody({
    tenantStateRoot: options.tenantStateRoot,
    privateKey: options.privateKey,
    space: [...spaces][0]!,
    abilities,
  });
}

export function callbackRequest(body: Record<string, unknown>): Request {
  return new Request("https://mcp.test/connect/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
