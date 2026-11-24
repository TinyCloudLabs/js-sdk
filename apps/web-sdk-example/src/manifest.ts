import { buildNetworkId, type Manifest } from "@tinycloud/web-sdk";

/**
 * The permissions this example asks for at sign-in.
 *
 * - KV at the root of the `default` space: StorageModule (`tcw.kv`),
 *   SpaceModule (`space("default").kv`), the vault's `vault/` entries, and the
 *   KV actions DelegationModule and share links hand on.
 * - Capabilities read on `default`: DelegationModule lists delegations.
 * - KV put in the `public` space: PublicSpaceModule writes.
 * - Decrypt on the signer's own `default` encryption network: VaultModule reads
 *   network-encrypted vault entries. The network id names the owner DID, so the
 *   manifest is built once the wallet address (EIP-55) and chain are known.
 */
export function exampleManifest(address: string, chainId: number): Manifest {
  return {
    app_id: "xyz.tinycloud.examples.web-sdk",
    name: "TinyCloud Web SDK Example",
    space: "default",
    prefix: "",
    defaults: false,
    permissions: [
      { service: "tinycloud.kv", path: "", actions: ["get", "put", "del", "list"] },
      { service: "tinycloud.capabilities", path: "", actions: ["read"] },
      { service: "tinycloud.kv", space: "public", path: "", actions: ["put"] },
      {
        service: "tinycloud.encryption",
        path: buildNetworkId(`did:pkh:eip155:${chainId}:${address}`, "default"),
        actions: ["decrypt"],
      },
    ],
  };
}
