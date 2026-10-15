import type { ReplicaGrantInfo } from "@tinycloud/sdk-services/kv/replication";

import { grantUnconstrained, parseUcanGrant } from "../grant.js";
import type { ReplicaState } from "../types.js";
import type { GrantPolicyView } from "../browser/store.js";
import type { KvOpenSpec } from "./protocol.js";

/**
 * `ReplicaGrantInfo` for the newest stored grant (a pending install
 * supersedes the active one): `parentCid` is the signed `prf[0]`,
 * `expiresAt` the signed `exp` in ms, and `unconstrained` is computed from
 * the signed attenuation.
 */
export function grantInfoOf(state: ReplicaState & { grantPolicyView?: GrantPolicyView }, spec: Pick<KvOpenSpec, "space" | "prefix">): ReplicaGrantInfo | null {
  const record = state.pendingGrant ?? state.grant;
  if (record === null) return null;
  const parsed = parseUcanGrant(record.bytes);
  const policy = state.grantPolicyView;
  const lifetime = policy?.grants[record.cid];
  return {
    cid: record.cid,
    parentCid: parsed.prf[0] ?? null,
    expiresAt: parsed.expiresAt === null ? null : parsed.expiresAt * 1000,
    state: state.pendingGrant !== null && record.cid === state.pendingGrant.cid ? "pending" : "active",
    unconstrained: grantUnconstrained(parsed, spec.space, spec.prefix),
    ...(policy === undefined ? {} : {
      ...(lifetime?.installedAt === undefined ? {} : { installedAt: lifetime.installedAt }),
      effectiveExpiresAt: lifetime?.effectiveExpiresAt ?? Number.NEGATIVE_INFINITY,
      consentDeadline: policy.consentDeadline,
      ...(policy.anchor === null ? {} : { consentAnchor: policy.anchor }),
    }),
  };
}
