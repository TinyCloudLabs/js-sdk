import type { PersistedSessionData } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "../../../node-sdk/src/NodeWasmBindings";
import { PrivateKeySigner } from "../../../node-sdk/src/signers/PrivateKeySigner";
import { PROOF_PRIVATE_KEY } from "../../../node-sdk/src/test-support/signed-restorable-session";

export async function signedBrowserSession(
  expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(),
  privateKey = PROOF_PRIVATE_KEY,
  spaceName = "default",
): Promise<PersistedSessionData> {
  const signer = new PrivateKeySigner(privateKey);
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, spaceName);
  const jwk = JSON.parse(manager.jwk("default")!);
  const prepared = wasm.prepareSession({
    address, chainId, spaceId, jwk, domain: "restore.test",
    abilities: { kv: { "": ["tinycloud.kv/get"] } },
    issuedAt: new Date(Math.min(Date.now(), new Date(expiresAt).getTime() - 60_000)).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    address: address.toLowerCase(), chainId, sessionKey: JSON.stringify(jwk), siwe: prepared.siwe, signature,
    tinycloudSession: { delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, verificationMethod: manager.getDID("default") },
    expiresAt, createdAt: new Date().toISOString(), version: "1.0",
  };
}
