import { TinyCloudNode, type NodeWasmBindings, type PrivateKeySigner } from "@tinycloud/node-sdk";

/**
 * A real node restored offline from an owner-signed session for `sessionKey`.
 * Storing a CLI grant reads its signed authority through this node exactly as
 * replay does, so tests that fake activation still store real bindings.
 */
export async function restoredOwnerNode(params: {
  wasm: NodeWasmBindings;
  signer: PrivateKeySigner;
  sessionKey: Record<string, unknown>;
  sessionDid: string;
  spaceId: string;
  host: string;
}): Promise<TinyCloudNode> {
  const address = await params.signer.getAddress();
  const now = Date.now();
  const prepared = params.wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId: params.spaceId, jwk: params.sessionKey,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 3_600_000).toISOString(),
  });
  const signature = await params.signer.signMessage(prepared.siwe);
  const session = params.wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({ host: params.host, wasmBindings: params.wasm });
  await node.restoreSession({
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId: params.spaceId,
    jwk: params.sessionKey,
    verificationMethod: params.sessionDid,
    address,
    chainId: 1,
    siwe: prepared.siwe,
    signature,
  });
  return node;
}
