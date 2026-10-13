import { NodeWasmBindings } from "../NodeWasmBindings.js";
import { PrivateKeySigner } from "../signers/PrivateKeySigner.js";
import type { PortableDelegation } from "../delegation.js";

const OWNER_PRIVATE_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

export async function mintCompactDelegation(options: {
  audience: string;
  expSecs: number;
  host?: string;
  transportExpiry?: string;
  /** The KV path and actions delegated; default `get` on `vault/secrets/KEY`. */
  grant?: { path: string; actions: string[] };
}): Promise<{ delegation: PortableDelegation; ownerDid: string; ownerAddress: string; spaceId: string }> {
  if (!Number.isInteger(options.expSecs)) throw new TypeError("expSecs must be an integer");
  const grant = options.grant ?? { path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] };
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(OWNER_PRIVATE_KEY);
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  const manager = wasm.createSessionManager();
  const ownerJwk = JSON.parse(manager.jwk("default")!);
  const ownerVm = manager.getDID("default");
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "vault/secrets/": ["tinycloud.kv/get", "tinycloud.kv/list"], ...(options.grant === undefined ? {} : { [grant.path]: grant.actions }) } },
    address,
    chainId: 1,
    domain: "cli.example.test",
    spaceId,
    jwk: ownerJwk,
    issuedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    expirationTime: new Date(Math.max(options.expSecs * 1000, now) + 2 * 60 * 60_000).toISOString(),
  });
  const ownerSession = wasm.completeSessionSetup({ ...prepared, signature: await signer.signMessage(prepared.siwe) });
  const raw = wasm.createDelegation(
    {
      delegationHeader: ownerSession.delegationHeader,
      delegationCid: ownerSession.delegationCid,
      jwk: ownerJwk,
      spaceId,
      verificationMethod: ownerVm.split("#", 1)[0]!,
    },
    options.audience,
    spaceId,
    { kv: { [grant.path]: grant.actions } },
    options.expSecs,
    0,
  );
  const delegation = {
    ...raw,
    delegationHeader: { Authorization: raw.delegation },
    spaceId,
    path: grant.path,
    actions: grant.actions,
    delegateDID: options.audience,
    ownerAddress: address,
    chainId: 1,
    expiry: options.transportExpiry ?? new Date(options.expSecs * 1000).toISOString(),
    ...(options.host === undefined ? {} : { host: options.host }),
  } as PortableDelegation;
  return { delegation, ownerDid: `did:pkh:eip155:1:${address}`, ownerAddress: address, spaceId };
}
