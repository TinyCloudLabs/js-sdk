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

function isRawRequest(permission: PermissionEntry): boolean {
  return (permission.service === "tinycloud.encryption" || permission.service === "encryption") &&
    permission.path.startsWith("urn:tinycloud:encryption:");
}

/**
 * OpenKey `/delegate` as deployed (openkey apps/api/src/routes/delegate-session.ts,
 * TC-598): it refuses a request without `tinycloud.capabilities/read`
 * (`assertRequiredActions`), whose non-raw entries do not name exactly one
 * space (`spacePrefixFromPermissions`), or whose raw decrypt sits inside a
 * space; otherwise the owner signs exactly the requested abilities, nested in
 * that space, with raw networks as top-level ReCap resources. Every request is
 * recorded in `requests`.
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
    if (!permissions.some((p) => p.service === "tinycloud.capabilities" && p.actions.includes("tinycloud.capabilities/read"))) {
      throw new Error("capabilities/read is required for this delegation");
    }
    const spaces = new Set(permissions.filter((p) => !isRawRequest(p)).map((p) =>
      (p.space ?? "").replace(/0x[0-9a-fA-F]{40}/, (owner) => owner.toLowerCase())));
    if (spaces.size !== 1) throw new Error("permissions must belong to a single space");
    if (permissions.some((p) => isRawRequest(p) && p.space !== undefined && p.space !== "encryption")) {
      throw new Error("Raw encryption networks are not inside a space");
    }
    const space = [...spaces][0]!;
    const abilities: Record<string, Record<string, string[]>> = {};
    const rawAbilities: Record<string, string[]> = {};
    for (const p of permissions) {
      if (isRawRequest(p)) {
        rawAbilities[p.path] = [...p.actions];
      } else {
        const service = p.service.slice("tinycloud.".length);
        abilities[service] = { ...abilities[service], [p.path]: [...p.actions] };
      }
    }
    const address = await params.signer.getAddress();
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
