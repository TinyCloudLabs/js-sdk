import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

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

export function callbackRequest(body: Record<string, unknown>): Request {
  return new Request("https://mcp.test/connect/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
