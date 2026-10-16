import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { principalDidEquals, type TinyCloudNode } from "@tinycloud/node-sdk";
import { additionalDelegationsPath, profilePath } from "@tinycloud/operations/state";
import { withoutBearer } from "@tinycloud/operations/delegation-binding";
import { parseSignedCompactUcanAttenuation, parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { ExitCode } from "../config/constants.js";
import type { ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { loadAdditionalDelegations } from "./permissions.js";

export interface LogoutRevocationPlan {
  cids: string[];
  excluded: Array<{ cid: string; reason: "inbound" | "non_owner" | "expired" | "already_revoked" }>;
}

function inventoryError(cid: string, detail: string): CLIError {
  return new CLIError(
    "REVOKE_INVENTORY_UNVERIFIED",
    `Cannot classify stored delegation ${cid}: ${detail}. The session, key, and replicas remain for a retry; local replica reads are denied.`,
    ExitCode.ERROR,
    { cid, hint: "Retry online after restoring the node query or correcting the signed grant artifact." },
  );
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function ownerSpaceResource(resource: string, ownerDid: string): boolean {
  const match = /^tinycloud:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):[^/]+\//.exec(resource);
  return match !== null && principalDidEquals(ownerDid, `did:pkh:eip155:${match[1]}:${match[2]}`);
}

async function signedOwnerGrant(cid: string, authorization: string, ownerDid: string, issuer?: string): Promise<boolean> {
  const token = withoutBearer(authorization);
  if (token.split(".").length === 3) {
    const signed = parseSignedCompactUcanAttenuation(token, cid);
    return (issuer === undefined || principalDidEquals(signed.payload.iss, issuer)) &&
      Object.keys(signed.payload.att).some((resource) => ownerSpaceResource(resource, ownerDid));
  }
  const signed = await parseSignedSiweCacao(token, cid);
  return principalDidEquals(signed.issuer, ownerDid) &&
    Object.keys(signed.attenuation).some((resource) => ownerSpaceResource(resource, ownerDid));
}

/** Fence local CID inventory across online work without holding a profile lock over node I/O. */
export async function logoutInventorySnapshot(profileName: string): Promise<string> {
  const root = profilePath(profileName);
  return JSON.stringify(await Promise.all([
    optionalFile(join(root, "auth-grant-artifacts.json")),
    optionalFile(additionalDelegationsPath(profileName)),
    optionalFile(join(root, "auth-grants.jsonl")),
  ]));
}

function targetOwner(resources: readonly { resource: string }[], ownerDid: string): "owner" | "other" | "unknown" {
  if (!Array.isArray(resources) || resources.length === 0) return "unknown";
  let unknown = false;
  for (const entry of resources) {
    if (typeof entry?.resource !== "string") return "unknown";
    if (ownerSpaceResource(entry.resource, ownerDid)) return "owner";
    if (!/^tinycloud:pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40}:[^/]+\//.test(entry.resource)) unknown = true;
  }
  return unknown ? "unknown" : "other";
}

/** Classify every stored CID before any remote revoke; history labels are never ownership proof. */
export async function planLogoutRevocations(input: {
  profileName: string;
  profile: Pick<ProfileConfig, "did" | "ownerDid" | "sessionDid">;
  session: { ownerDid: string; delegationCid: string };
  host: string;
  node: TinyCloudNode;
}): Promise<LogoutRevocationPlan> {
  const { profileName, profile, session, node } = input;
  const sessionCid = session.delegationCid;
  if (!session.ownerDid || !sessionCid) throw inventoryError(sessionCid || "session", "the active session has no owner or CID");
  const root = profilePath(profileName);
  const included = new Set<string>();
  const unresolved = new Set<string>();
  const excluded: LogoutRevocationPlan["excluded"] = [];

  const artifactText = await optionalFile(join(root, "auth-grant-artifacts.json"));
  if (artifactText !== null) {
    let records: unknown;
    try { records = JSON.parse(artifactText); } catch { throw inventoryError("artifact file", "invalid JSON"); }
    if (!Array.isArray(records)) throw inventoryError("artifact file", "expected an array of signed grants");
    for (const record of records) {
      const cid = record && typeof record === "object" && "delegationCid" in record && typeof record.delegationCid === "string"
        ? record.delegationCid : "artifact entry";
      const delegation = record && typeof record === "object" && "delegation" in record ? record.delegation : undefined;
      const authorization = delegation && typeof delegation === "object" && "delegationHeader" in delegation &&
        delegation.delegationHeader && typeof delegation.delegationHeader === "object" &&
        "Authorization" in delegation.delegationHeader ? delegation.delegationHeader.Authorization : undefined;
      if (!cid || !delegation || typeof delegation !== "object" || !("cid" in delegation) || delegation.cid !== cid ||
          typeof authorization !== "string") throw inventoryError(cid, "the issued grant record is malformed");
      try {
        if (await signedOwnerGrant(cid, authorization, session.ownerDid)) included.add(cid);
        else unresolved.add(cid);
      } catch {
        throw inventoryError(cid, "the purported issued grant has no verifiable exact-CID signature");
      }
    }
  }

  for (const entry of await loadAdditionalDelegations(profileName)) {
    const cid = entry?.delegation?.cid;
    if (typeof cid !== "string" || !cid || cid === sessionCid || included.has(cid)) continue;
    const authorization = entry.delegation.delegationHeader?.Authorization;
    if (typeof authorization !== "string") {
      unresolved.add(cid);
      continue;
    }
    try {
      if (await signedOwnerGrant(cid, authorization, session.ownerDid, profile.sessionDid ?? profile.did)) included.add(cid);
      else unresolved.add(cid);
    } catch {
      unresolved.add(cid);
    }
  }

  const historyText = await optionalFile(join(root, "auth-grants.jsonl"));
  if (historyText !== null) {
    for (const line of historyText.split("\n").filter((row) => row.trim().length > 0)) {
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw inventoryError("history file", "invalid JSONL"); }
      if (!record || typeof record !== "object" || !("source" in record) || typeof record.source !== "string") {
        throw inventoryError("history file", "malformed history row");
      }
      const cid = "delegationCid" in record ? record.delegationCid : undefined;
      if (cid === undefined) continue;
      if (typeof cid !== "string" || !cid) throw inventoryError("history file", "invalid CID");
      if (cid !== sessionCid && !included.has(cid)) unresolved.add(cid);
    }
  }
  unresolved.delete(sessionCid);
  for (const cid of included) unresolved.delete(cid);

  if (unresolved.size > 0) {
    const records = new Map<string, { direction: string; status: string; owner: "owner" | "other" | "unknown"; delegatorDid: string }>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await node.delegationManager.query({ direction: "all", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw inventoryError([...unresolved][0]!, "the node could not provide authoritative target ownership");
      for (const item of result.data.items) {
        if (!unresolved.has(item.cid)) continue;
        const owner = targetOwner(item.resources, session.ownerDid);
        const prior = records.get(item.cid);
        if (prior && (prior.direction !== item.direction || prior.status !== item.status ||
            prior.owner !== owner || prior.delegatorDid !== item.delegatorDid)) {
          throw inventoryError(item.cid, "the node returned conflicting target records");
        }
        records.set(item.cid, { direction: item.direction, status: item.status, owner, delegatorDid: item.delegatorDid });
      }
      cursor = result.data.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw inventoryError([...unresolved][0]!, "the node repeated a query cursor");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    for (const cid of unresolved) {
      const target = records.get(cid);
      if (!target) throw inventoryError(cid, "the node returned no matching target record");
      if (target.status === "expired") excluded.push({ cid, reason: "expired" });
      else if (target.status === "revoked" || target.status === "ancestor_revoked") excluded.push({ cid, reason: "already_revoked" });
      else if (target.direction === "received") {
        if (principalDidEquals(target.delegatorDid, session.ownerDid)) {
          throw inventoryError(cid, "the node returned conflicting inbound owner authority");
        }
        excluded.push({ cid, reason: "inbound" });
      } else if (target.direction === "granted" && target.owner === "owner") included.add(cid);
      else if (target.direction === "granted" && target.owner === "other") excluded.push({ cid, reason: "non_owner" });
      else throw inventoryError(cid, "the node did not identify a grantor");
    }
  }
  included.delete(sessionCid);
  return { cids: [...included, sessionCid], excluded };
}
