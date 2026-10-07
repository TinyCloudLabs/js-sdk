import type { NodeWasmBindings, PermissionEntry, PrivateKeySigner } from "@tinycloud/node-sdk";

export type OpenKeyCallback = {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  [key: string]: unknown;
};

export type OpenKeyDelegate = (
  did: string,
  options?: { permissions?: PermissionEntry[] },
) => Promise<OpenKeyCallback>;

const RAW_NETWORK = /^urn:tinycloud:encryption:did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40}):([^:]*)$/;
const NETWORK_NAME = /^[a-z0-9][a-z0-9-]*$/;


function isRawRequest(permission: PermissionEntry): boolean {
  return (permission.service === "tinycloud.encryption" || permission.service === "encryption") &&
    typeof permission.path === "string" && permission.path.startsWith("urn:tinycloud:encryption:");
}

/**
 * `spacePrefixFromPermissions` and `assertRawEncryptionPermission` in
 * delegate-session.ts, as deployed with TC-598. It refuses what those refuse:
 * - a non-raw entry without a space, or entries in more than one space;
 * - a request without `tinycloud.capabilities/read` when requesting a space;
 * - a raw network entry inside a space, with any action but decrypt, owned by
 *   anyone but the signer, or with an invalid network name.
 * It then has the owner sign exactly the requested abilities, nested in that
 * space, with raw encryption resources as top-level ReCap resources.
 */
export function openKeyDelegate(params: {
  wasm: NodeWasmBindings;
  signer: PrivateKeySigner;
  sessionKey: object;
  sessionDid: string;
}): { delegate: OpenKeyDelegate; requests: PermissionEntry[][] } {
  const requests: PermissionEntry[][] = [];
  const delegate: OpenKeyDelegate = async (_did, { permissions = [] } = {}) => {
    requests.push(permissions);
    const address = await params.signer.getAddress();
    if (permissions.length === 0) throw new Error("permissions must be a non-empty array");
    permissions.forEach((p, index) => {
      if (!isRawRequest(p) && (typeof p.space !== "string" || p.space.length === 0)) {
        throw new Error(`permissions[${index}].space is required`);
      }
      if (!isRawRequest(p)) return;
      if (p.space !== undefined && p.space !== "encryption") {
        throw new Error(`permissions[${index}].space must be "encryption" or absent for a raw encryption network`);
      }
      if (p.actions.length === 0 || p.actions.some((action) => action !== "tinycloud.encryption/decrypt")) {
        throw new Error(`permissions[${index}].actions must be ["tinycloud.encryption/decrypt"] for a raw encryption network`);
      }
      const network = RAW_NETWORK.exec(p.path);
      if (!network || network[1] !== "1" || network[2]!.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`permissions[${index}].path must be an encryption network owned by the signer`);
      }
      if (!NETWORK_NAME.test(network[3]!)) {
        throw new Error(`permissions[${index}].path names an invalid network`);
      }
    });
    const hasSpacePermission = permissions.some((permission) => !isRawRequest(permission));
    if (hasSpacePermission && !permissions.some((p) =>
      p.service === "tinycloud.capabilities" && p.actions.includes("tinycloud.capabilities/read")
    )) {
      throw new Error("capabilities/read is required for a space delegation");
    }
    const spaces = new Set(permissions.filter((p) => !isRawRequest(p)).map((p) =>
      p.space!.replace(/0x[0-9a-fA-F]{40}/, (owner) => owner.toLowerCase())));
    if (spaces.size > 1 || spaces.size === 0) {
      throw new Error("permissions must belong to a single space");
    }
    const space = [...spaces][0] ?? "applications";
    const abilities: Record<string, Record<string, string[]>> = {};
    const rawAbilities: Record<string, string[]> = {};
    for (const p of permissions) {
      if (isRawRequest(p)) {
        rawAbilities[p.path] = [...new Set([...(rawAbilities[p.path] ?? []), ...p.actions])];
      } else {
        const service = p.service.slice("tinycloud.".length);
        const actions = abilities[service]?.[p.path] ?? [];
        abilities[service] = { ...abilities[service], [p.path]: [...new Set([...actions, ...p.actions])] };
      }
    }
    const spaceId = params.wasm.makeSpaceId(address, 1, space.slice(space.lastIndexOf(":") + 1));
    const now = Date.now();
    const prepared = params.wasm.prepareSession({
      abilities,
      ...(Object.keys(rawAbilities).length > 0 ? { rawAbilities } : {}),
      address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk: params.sessionKey,
      issuedAt: new Date(now - 60_000).toISOString(),
      expirationTime: new Date(now + 3600_000).toISOString(),
    });
    const signature = await params.signer.signMessage(prepared.siwe);
    return {
      ...params.wasm.completeSessionSetup({ ...prepared, signature }),
      address, chainId: 1, spaceId, verificationMethod: params.sessionDid, siwe: prepared.siwe, signature,
    };
  };
  return { delegate, requests };
}
