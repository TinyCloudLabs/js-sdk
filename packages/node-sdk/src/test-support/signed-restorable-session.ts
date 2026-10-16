import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";

export const PROOF_PRIVATE_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

export async function signedRestorableSession(options?: {
  expirationless?: boolean;
  expired?: boolean;
  spaces?: Record<string, string>;
  signedSpaces?: Record<string, string>;
  abilities?: Record<string, Record<string, string[]>>;
  /** Signed onto every ReCap action before the owner signs. */
  caveat?: Record<string, unknown>;
}) {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const now = new Date();
  const issuedAt = options?.expired
    ? new Date(now.getTime() - 2 * 60 * 60_000)
    : now;
  const expirationTime = options?.expired
    ? new Date(now.getTime() - 60 * 60_000)
    : new Date(now.getTime() + 60 * 60_000);
  const verificationMethod = manager.getDID("default");
  const prepared = options?.expirationless
    ? {
      jwk,
      spaceId,
      verificationMethod,
      siwe: (manager as any).build({
        address,
        chainId,
        domain: "restore.test",
        issuedAt: issuedAt.toISOString(),
      }, "default"),
    }
    : wasm.prepareSession({
      abilities: options?.abilities ?? { kv: { "": ["tinycloud.kv/get"] } },
      address,
      chainId,
      domain: "restore.test",
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      additionalSpaces: options?.signedSpaces ?? options?.spaces,
      jwk,
    });
  if (options?.caveat) prepared.siwe = withRecapCaveat(prepared.siwe, options.caveat);
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const expiresAt = options?.expirationless
    ? new Date(now.getTime() + 30 * 60_000).toISOString()
    : expirationTime.toISOString();
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    spaces: options?.spaces,
    jwk,
    verificationMethod,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiresAt,
  };
}

/** The SIWE with `caveat` as the note-bene of every ReCap action (prepareSession signs only `[{}]`). */
export function withRecapCaveat(siwe: string, caveat: Record<string, unknown>): string {
  const encoded = siwe.match(/urn:recap:([A-Za-z0-9_-]+)/)?.[1];
  if (encoded === undefined) throw new Error("SIWE has no ReCap resource");
  const recap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown[]>> };
  for (const abilities of Object.values(recap.att)) {
    for (const action of Object.keys(abilities)) abilities[action] = [caveat];
  }
  return siwe.replace(encoded, Buffer.from(JSON.stringify(recap)).toString("base64url"));
}
