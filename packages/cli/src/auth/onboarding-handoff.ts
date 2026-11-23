import { createHash } from "node:crypto";
import { extractSiweExpiration, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId, pkhDid, principalDid, TERMINAL_DELEGATION_FACT } from "@tinycloud/sdk-core";
import { parseSignedUcan } from "@tinycloud/share-sdk/share-index";
import { permissionsFromDelegation } from "../lib/permissions.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { generateKey } from "./local-key.js";
import { scopeCovers } from "./scoped-login.js";

const RECORD_PREFIX = "xyz.tinycloud.one/handoff/v1/";
const APPS_PREFIX = "applications/";
const BUILTIN_APPS = new Set(["default", "applications", "account", "secrets", "public", "agents"].map(name => `xyz.tinycloud.${name}`));
const IDENTITY_LABELS = { agent: "TinyCloud agent", machinePrefix: "Computer " };
const HANDOFF_URL_PREFIX = "https://tinycloud.one/handoff#tch1";
const LINK_MAX_LENGTH = 1_800;
const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KV_GET = "tinycloud.kv/get";

const FEED_ONLY = "Your Feed is set up. This setup doesn't give your agent access to your app list, so there's no setup link.";
const NO_HANDOFF = "You're set up. Sign in at tinycloud.one to get started.";

type Handoff = { url: string; expiresAt: string } | { message: string };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encodeLink(seed: Uint8Array, ucan: string): string {
  if (seed.length !== 32 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ucan) ||
      HANDOFF_URL_PREFIX.length + Math.ceil((seed.length + ucan.length) * 8 / 5) > LINK_MAX_LENGTH) {
    throw new Error("Invalid handoff link payload");
  }
  let url = HANDOFF_URL_PREFIX;
  let bits = 0;
  let pending = 0;
  for (let i = 0; i < seed.length + ucan.length; i++) {
    pending = (pending << 8) | (i < seed.length ? seed[i]! : ucan.charCodeAt(i - seed.length));
    bits += 8;
    while (bits >= 5) url += CROCKFORD[(pending >>> (bits -= 5)) & 31];
  }
  if (bits !== 0) url += CROCKFORD[(pending << (5 - bits)) & 31];
  return url;
}

async function snapshotApps(node: TinyCloudNode, space: string): Promise<{ app_ids: string[]; apps_truncated: boolean }> {
  const kv = node.kvForSpace(space);
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  do {
    const result = await kv.list({ prefix: APPS_PREFIX, source: "network", limit: 1000, cursor });
    if (!result.ok) throw new Error("Could not list apps for handoff");
    for (const key of result.data.keys) {
      if (!key.startsWith(APPS_PREFIX)) continue;
      const id = key.slice(APPS_PREFIX.length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) || BUILTIN_APPS.has(id) || ids.includes(id)) continue;
      if (ids.length === 32) {
        truncated = true;
        if (id > ids[31]!) continue;
        ids.pop();
      }
      ids.push(id);
      ids.sort();
    }
    cursor = result.data.nextCursor;
    if (cursor ? cursors.has(cursor) : result.data.truncated) throw new Error("Incomplete app list for handoff");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { app_ids: ids, apps_truncated: truncated };
}

async function createHandoff(node: TinyCloudNode, permissions: PermissionEntry[], parentCid: string): Promise<Handoff> {
  const session = node.restorableSession;
  if (!session || !node.isSessionOnly) return { message: NO_HANDOFF };
  const issuer = principalDid(session.verificationMethod);
  const owner = pkhDid(session.address, session.chainId);
  const space = makePkhSpaceId(session.address, session.chainId, "applications");
  const primary = session.delegationCid === parentCid;
  const additional = primary ? undefined : node.getRuntimePermissionDelegations().find(grant => grant.cid === parentCid);
  if (!primary && (!additional || normalizePkhIdentifier(additional.spaceId) !== normalizePkhIdentifier(space))) {
    return { message: NO_HANDOFF };
  }
  const parentSiwe = primary ? session.siwe : additional?.siweProof?.siwe;
  const parentExpiresAt = parentSiwe ? extractSiweExpiration(parentSiwe) : undefined;
  if (parentExpiresAt === undefined || parentExpiresAt.getTime() <= Date.now() ||
      !scopeCovers(additional ? permissionsFromDelegation(additional) : node.getVerifiedSessionCapabilities(), permissions, owner)) {
    return { message: NO_HANDOFF };
  }

  const key = RECORD_PREFIX + sha256Hex(`${issuer}\n${parentCid}`).slice(0, 32);
  const kv = node.kvForSpace(space);
  const descendants = await kv.list({ prefix: `${key}/`, source: "network", limit: 1 });
  if (!descendants.ok || descendants.data.keys.length !== 0 || descendants.data.truncated || descendants.data.nextCursor) {
    return { message: NO_HANDOFF };
  }
  const apps = await snapshotApps(node, makePkhSpaceId(session.address, session.chainId, "account"));
  const recipient = generateKey();
  const audience = principalDid(recipient.did);
  if (!("d" in recipient.jwk) || typeof recipient.jwk.d !== "string") return { message: NO_HANDOFF };
  const seed = Buffer.from(recipient.jwk.d, "base64url");

  let handoff: { url: string; expiresAt: string } | undefined;
  const expiry = Math.min(LINK_LIFETIME_MS, parentExpiresAt.getTime() - Date.now());
  if (expiry <= 0) return { message: NO_HANDOFF };
  const result = await node.delegateTo(audience, [{ service: "tinycloud.kv", space, path: key, actions: [KV_GET] }], {
    expiry,
    requireActivation: true,
    disableSubDelegation: true,
    onPrepared: async (prepared) => {
      const ucan = prepared.delegationHeader.Authorization;
      const proof = parseSignedUcan(ucan, prepared.cid);
      const now = Date.now();
      const maxExpiry = Math.floor(Math.min(now + LINK_LIFETIME_MS, parentExpiresAt.getTime()) / 1000);
      const [resource] = Object.keys(proof.attenuation);
      const actions = resource === undefined ? undefined : proof.attenuation[resource];
      const caveats = actions?.[KV_GET];
      const expectedResource = `${normalizePkhIdentifier(space)}/kv/${key}`;
      if (proof.issuer !== issuer || proof.audience !== audience || proof.proofs.length !== 1 || proof.proofs[0] !== parentCid ||
          proof.expiresAt <= Math.floor(now / 1000) || proof.expiresAt > maxExpiry || prepared.expiry.getTime() !== proof.expiresAt * 1000 ||
          (proof.notBefore !== undefined && proof.notBefore > Math.floor(now / 1000)) ||
          Object.keys(proof.attenuation).length !== 1 || resource === undefined || normalizePkhIdentifier(resource) !== expectedResource ||
          actions === undefined || Object.keys(actions).length !== 1 || JSON.stringify(caveats) !== "[{}]" ||
          JSON.stringify(proof.facts) !== JSON.stringify([TERMINAL_DELEGATION_FACT])) {
        throw new Error("Unexpected handoff delegation authority");
      }
      handoff = { url: encodeLink(seed, ucan), expiresAt: prepared.expiry.toISOString() };
    },
  });
  if (result.prompted || handoff === undefined || result.delegation.expiry.getTime() <= Date.now()) return { message: NO_HANDOFF };

  const record = JSON.stringify({
    version: 1,
    agent_name: IDENTITY_LABELS.agent,
    machine_label: IDENTITY_LABELS.machinePrefix + sha256Hex(issuer).slice(0, 6).toUpperCase(),
    connected_at: new Date().toISOString(),
    access_expires_at: parentExpiresAt.toISOString(),
    abilities: ["apps_data", "account_index", ...(permissions.some(permission => permission.service === "tinycloud.hooks") ? ["feed"] : [])],
    ...apps,
  });
  if (Buffer.byteLength(record) > 4096) return { message: NO_HANDOFF };
  const written = await kv.put(key, record, { contentType: "application/json" });
  return written.ok && result.delegation.expiry.getTime() > Date.now() ? handoff : { message: NO_HANDOFF };
}

export async function onboardingHandoff(
  permissions: PermissionEntry[],
  approvalCid: string | undefined,
  authenticatedNode: () => Promise<TinyCloudNode>,
): Promise<Handoff> {
  if (!permissions.some(permission => permission.space === "account")) return { message: FEED_ONLY };
  if (approvalCid === undefined) return { message: NO_HANDOFF };
  try {
    return await createHandoff(await authenticatedNode(), permissions, approvalCid);
  } catch {
    return { message: NO_HANDOFF };
  }
}
