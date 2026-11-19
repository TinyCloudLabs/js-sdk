import { buildNetworkId, type Manifest } from "@tinycloud/web-sdk";

const APP_ID = "xyz.tinycloud.examples.openkey";
const APP_NAME = "TinyCloud OpenKey Example";

/**
 * The permissions the editor asks for at sign-in.
 *
 * - KV at the root of the `default` space: documents (`tcw.kv`), SpaceModule
 *   (`space("default").kv`), the vault's `vault/` entries, and the KV actions
 *   DelegationModule and share links hand on.
 * - Capabilities read on `default`: DelegationModule lists delegations.
 * - Decrypt on the signer's own `default` encryption network: encrypted
 *   documents and VaultModule read network-encrypted vault entries. The
 *   network id names the owner DID, so the manifest is built once the OpenKey
 *   address (EIP-55) and chain are known.
 */
export function editorManifest(address: string, chainId: number): Manifest {
  return {
    app_id: APP_ID,
    name: APP_NAME,
    space: "default",
    prefix: "",
    defaults: false,
    permissions: [
      { service: "tinycloud.kv", path: "", actions: ["get", "put", "del", "list"] },
      { service: "tinycloud.capabilities", path: "", actions: ["read"] },
      {
        service: "tinycloud.encryption",
        path: buildNetworkId(`did:pkh:eip155:${chainId}:${address}`, "default"),
        actions: ["decrypt"],
      },
    ],
  };
}

/**
 * The share page reads and writes through the share link's own key; signing
 * in only establishes the viewer's session, so it asks for nothing more.
 */
export const SHARED_VIEWER_MANIFEST: Manifest = {
  app_id: APP_ID,
  name: APP_NAME,
  space: "default",
  prefix: "",
  defaults: false,
  permissions: [{ service: "tinycloud.capabilities", path: "", actions: ["read"] }],
};
