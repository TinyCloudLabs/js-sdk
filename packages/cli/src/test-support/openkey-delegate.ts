import { parseNetworkId, parseScopedDecryptResource, type NodeWasmBindings, type PermissionEntry, type PrivateKeySigner } from "@tinycloud/node-sdk";

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



function isRawRequest(permission: PermissionEntry): boolean {
  return (permission.service === "tinycloud.encryption" || permission.service === "encryption") &&
    typeof permission.path === "string" && permission.path.startsWith("urn:tinycloud:encryption:");
}

/**
 * Mirrors OpenKey commit a733255c, `delegate-session.ts`:
 * `spacePrefixFromPermissions` treats only encryption URNs as space-less;
 * `sessionAbilitiesFromPermissions` emits only encryption URNs as top-level
 * ReCap resources. Raw `urn:cid:` is therefore another space, not a raw
 * capability. Browser refusals surface to the CLI as an auth timeout.
 *
 * This stand-in is deliberately narrower on baseline capabilities/read: it
 * requires read for every space delegation, whereas production requires it
 * conditionally. CLI grant requests include read, so this does not narrow
 * the supported CLI flows.
 */
export function openKeyDelegate(params: {
  wasm: NodeWasmBindings;
  signer: PrivateKeySigner;
  sessionKey: object;
  sessionDid: string;
}): { delegate: OpenKeyDelegate; requests: PermissionEntry[][]; refusals: Array<{ code: "invalid_permissions"; message: string }> } {
  const requests: PermissionEntry[][] = [];
  const refusals: Array<{ code: "invalid_permissions"; message: string }> = [];
  const delegate: OpenKeyDelegate = async (_did, { permissions = [] } = {}) => {
    requests.push(permissions);
    const refuse = (message: string): never => {
      refusals.push({ code: "invalid_permissions", message });
      throw new Error("Authentication timed out after 5 minutes");
    };
    const address = await params.signer.getAddress();
    if (permissions.length === 0) refuse("permissions must be a non-empty array");
    permissions.forEach((p, index) => {
      if (!isRawRequest(p) && (typeof p.space !== "string" || p.space.length === 0)) {
        refuse(`permissions[${index}].space is required`);
      }
      if (!isRawRequest(p)) return;
      if (p.space !== undefined && p.space !== "encryption") {
        refuse(`permissions[${index}].space must be "encryption" or absent for a raw encryption network`);
      }
      if (p.actions.length === 0 || p.actions.some((action) => action !== "tinycloud.encryption/decrypt")) {
        refuse(`permissions[${index}].actions must be ["tinycloud.encryption/decrypt"] for a raw encryption network`);
      }
      let networkId: string;
      try {
        networkId = p.path.includes("/kv/")
          ? parseScopedDecryptResource(p.path).networkId
          : parseNetworkId(p.path).networkId;
      } catch {
        return refuse(`permissions[${index}].path must be a canonical encryption network or exact named-secret resource`);
      }
      const network = parseNetworkId(networkId);
      if (network.ownerDid !== `did:pkh:eip155:1:${params.wasm.ensureEip55(address)}`) {
        return refuse(`permissions[${index}].path must be an encryption network owned by the signer`);
      }
    });
    const hasSpacePermission = permissions.some((permission) => !isRawRequest(permission));
    if (hasSpacePermission && !permissions.some((p) =>
      p.service === "tinycloud.capabilities" && p.actions.includes("tinycloud.capabilities/read")
    )) {
      refuse("capabilities/read is required for a space delegation");
    }
    const spaces = new Set(permissions.filter((p) => !isRawRequest(p)).map((p) =>
      p.space!.replace(/0x[0-9a-fA-F]{40}/, (owner) => owner.toLowerCase())));
    if (spaces.size > 1 || spaces.size === 0) {
      refuse("permissions must belong to a single space");
    }
    if (permissions.some((p) => p.space?.startsWith("urn:cid:"))) {
      refuse("raw urn:cid revocation resources cannot be encoded as top-level ReCap resources");
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
  return { delegate, requests, refusals };
}
