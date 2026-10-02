import * as sdk from "@tinycloud/node-sdk";
import type { PermissionEntry, PortableDelegation, RuntimeDelegationActivator, ValidatedRuntimeDelegation } from "@tinycloud/node-sdk";
import { canonicalizeRecapCaveats } from "@tinycloud/sdk-core";

/** Public signed proof retained separately from transport/display metadata.
 * The current selected profile supplies its private key only at replay time. */
export interface StoredSessionProof {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  verificationMethod: string;
  address: string;
  chainId: number;
  siwe: string;
  signature: string;
  expiresAt: string;
}

function invalid(): never { throw new Error("Stored runtime session proof is invalid or does not match the active context."); }
const hostIdentity = (host: string) => host.replace(/\/+$/, "");
const spaceIdentity = (space: string) => space.replace(/(eip155:\d+:)(0x[0-9a-fA-F]{40})/, (_, prefix, address: string) => prefix + address.toLowerCase());

function parseProof(value: unknown): StoredSessionProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  for (const key of ["delegationCid", "spaceId", "verificationMethod", "address", "siwe", "signature", "expiresAt"] as const) {
    if (typeof p[key] !== "string" || !p[key]) return invalid();
  }
  if (!Number.isSafeInteger(p.chainId) || (p.chainId as number) <= 0 ||
    !p.delegationHeader || typeof p.delegationHeader !== "object" ||
    typeof (p.delegationHeader as { Authorization?: unknown }).Authorization !== "string") return invalid();
  // Only these fields may reach verification; persisted JWK/host overrides are ignored.
  return {
    delegationHeader: { Authorization: (p.delegationHeader as { Authorization: string }).Authorization },
    delegationCid: p.delegationCid as string, spaceId: p.spaceId as string,
    verificationMethod: p.verificationMethod as string, address: p.address as string,
    chainId: p.chainId as number, siwe: p.siwe as string, signature: p.signature as string, expiresAt: p.expiresAt as string,
  };
}

function authorityTokens(entries: readonly PermissionEntry[]): string {
  return JSON.stringify([...new Set(entries.flatMap(p => p.actions.map(action => JSON.stringify([
    p.service.startsWith("tinycloud.") ? p.service : `tinycloud.${p.service}`,
    p.service === "encryption" || p.service === "tinycloud.encryption" ? "" : spaceIdentity(p.space ?? ""),
    p.path, action, canonicalizeRecapCaveats(p.caveats),
  ]))))].sort());
}

/** Reverify CACAO proofs locally before activation. Compact UCANs retain their
 * existing CID/signed-authority validation path; neither format trusts display permissions. */
export async function activateStoredRuntimeDelegation(
  node: RuntimeDelegationActivator,
  entry: { delegation: PortableDelegation; sessionProof?: unknown },
  options: { host: string; jwk?: object },
): Promise<ValidatedRuntimeDelegation> {
  if (entry.sessionProof === undefined) {
    return sdk.activateValidatedRuntimeDelegation(node, entry.delegation, { host: options.host });
  }
  const verified = (() => {
    try {
      const proof = parseProof(entry.sessionProof);
      const d = entry.delegation;
      if (!options.jwk || typeof options.jwk !== "object" || !node.did ||
        typeof d.host !== "string" || hostIdentity(d.host) !== hostIdentity(options.host) ||
        d.cid !== proof.delegationCid || d.delegationHeader.Authorization !== proof.delegationHeader.Authorization ||
        spaceIdentity(d.spaceId) !== spaceIdentity(proof.spaceId) ||
        !sdk.principalDidEquals(d.delegateDID, node.sessionDid) ||
        !sdk.principalDidEquals(proof.verificationMethod, node.sessionDid) ||
        !sdk.principalDidEquals(sdk.pkhDid(d.ownerAddress, d.chainId), sdk.pkhDid(proof.address, proof.chainId)) ||
        !sdk.principalDidEquals(node.did, sdk.pkhDid(proof.address, proof.chainId))) return invalid();
      const wasm = new sdk.NodeWasmBindings();
      const manager = wasm.createSessionManager();
      if (typeof manager.replaceSessionKey !== "function") return invalid();
      const id = manager.replaceSessionKey(options.jwk, "verified-additional");
      if (!sdk.principalDidEquals(manager.getDID(id), node.sessionDid)) return invalid();
      const witness: { expiresAt?: string; verifiedRecap?: Array<{
        service: string; space: string; path: string; actions: string[]; caveats: Record<string, unknown>[];
      }> } = wasm.validatePersistedSession({ ...proof, jwk: options.jwk });
      if (!witness.expiresAt || !Number.isFinite(Date.parse(witness.expiresAt)) ||
        Date.parse(witness.expiresAt) <= Date.now() || Date.parse(witness.expiresAt) !== Date.parse(proof.expiresAt) ||
        !(d.expiry instanceof Date) || d.expiry.getTime() !== Date.parse(witness.expiresAt) ||
        !Array.isArray(witness.verifiedRecap) || !witness.verifiedRecap.length) return invalid();
      const effectivePermissions: PermissionEntry[] = witness.verifiedRecap.map(p => {
        if (typeof p.service !== "string" || typeof p.space !== "string" || typeof p.path !== "string" ||
          !Array.isArray(p.actions) || !p.actions.length || !p.actions.every(a => typeof a === "string") ||
          !Array.isArray(p.caveats) || !p.caveats.every(c => c !== null && typeof c === "object" && !Array.isArray(c))) return invalid();
        const caveats = p.caveats.map(c => {
          // WASM may expose an unconstrained branch as Map(). Nonempty Maps
          // require a complete JSON conversion and remain unsupported here.
          if (c instanceof Map) { if (c.size !== 0) return invalid(); return {}; }
          return c;
        });
        const service = p.service.startsWith("tinycloud.") ? p.service : `tinycloud.${p.service}`;
        return { service, ...(service === "tinycloud.encryption" ? {} : { space: spaceIdentity(p.space) }), path: p.path,
          actions: p.actions.map(a => a.includes("/") ? a : `${service}/${a}`),
          ...(canonicalizeRecapCaveats(caveats) === "[]" ? {} : { caveats: structuredClone(caveats) }),
        };
      });
      const declared = d.resources?.map(r => ({ service: r.service, space: r.space, path: r.path, actions: r.actions, caveats: r.caveats })) ??
        d.actions.map(action => ({ service: action.split("/")[0]!, space: d.spaceId, path: d.path, actions: [action], caveats: d.caveats }));
      if (authorityTokens(declared) !== authorityTokens(effectivePermissions)) return invalid();
      const resources = effectivePermissions.map(p => ({ service: p.service.replace(/^tinycloud\./, ""), space: p.space ?? "encryption", path: p.path, actions: [...p.actions], ...(p.caveats === undefined ? {} : { caveats: structuredClone(p.caveats) }) }));
      const primary = resources[0]!;
      const delegation: PortableDelegation = {
        cid: proof.delegationCid, delegationHeader: proof.delegationHeader, spaceId: proof.spaceId,
        delegateDID: node.sessionDid, delegatorDID: sdk.pkhDid(proof.address, proof.chainId),
        ownerAddress: proof.address, chainId: proof.chainId, host: options.host,
        expiry: new Date(witness.expiresAt), path: primary.path, actions: [...primary.actions], resources,
      };
      return { delegation, effectivePermissions };
    } catch { return invalid(); }
  })();
  await node.useRuntimeDelegation(verified.delegation);
  return { ...verified, cid: verified.delegation.cid, expiry: verified.delegation.expiry, audience: node.sessionDid, host: options.host };
}
