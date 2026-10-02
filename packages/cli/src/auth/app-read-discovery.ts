import type { PermissionEntry } from '@tinycloud/node-sdk';
import { SiweMessage } from 'siwe';
import { parseExpiry } from '../../../sdk-core/src/manifest.js';
import { hashApplicationManifests } from '../../../sdk-core/src/account/applicationRecords.js';
import { CLIError } from '../output/errors.js';
import { ExitCode } from '../config/constants.js';
import { verifyScopedLogin, validateLoginPermissions } from './scoped-login.js';
import { APP_READ_PROTOCOL_VERSION, appReadSelection, canonicalJson, canonicalPermissions, ownerSpace, registryReadPermissions, sha256, publicClientKey, type RegisteredReadApp, type AppReadPermission } from './app-read-policy.js';

function reject(code = 'OPENKEY_DISCOVERY_MISMATCH'): never {
  throw new CLIError(code, 'The approved app read does not match the canonical registry and pending login. No session was saved.', ExitCode.PERMISSION_DENIED);
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function resolvePermissions(entries: PermissionEntry[], owner: string): AppReadPermission[] {
  return canonicalPermissions(entries.map(entry => ({ service: entry.service, space: ownerSpace(owner, entry.space!), path: entry.path, actions: entry.actions })));
}

export function validateAppReadRegistryPermissions(registry: PermissionEntry[], owner?: string): void {
  try {
    validateLoginPermissions(registry, true);
    const declared = registry.find(p => p.space?.startsWith('tinycloud:'))?.space;
    const identity = owner ?? (declared ? `did:${declared.slice('tinycloud:'.length, declared.lastIndexOf(':'))}` : 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001');
    if (!same(resolvePermissions(registry, identity), canonicalPermissions(registryReadPermissions(identity)))) reject('INVALID_LOGIN_SCOPE');
  } catch { reject('INVALID_LOGIN_SCOPE'); }
}

/** Bind a locally selected canonical registration to this pending fixed request.
 * Its signed proof is still checked and the registration reread before saving. */
export function validateFixedAppReadSelection(selection: Record<string, unknown>, key: object, permissions: PermissionEntry[], host: string, expectedOwner?: string): PermissionEntry[] {
  try {
    const { selectionDigest, ...details } = selection;
    const publicKey = key as Record<string, unknown>;
    if (selection.schemaVersion !== 1 || selection.protocolVersion !== APP_READ_PROTOCOL_VERSION ||
        typeof selection.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selection.appId) ||
        typeof selection.ownerDid !== 'string' || selection.host !== host ||
        typeof selection.manifestHash !== 'string' || !/^[a-f0-9]{16}$/.test(selection.manifestHash) ||
        selectionDigest !== sha256(details) ||
        selection.clientKeyDigest !== sha256(publicClientKey({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x })) ||
        (expectedOwner && selection.ownerDid.toLowerCase() !== expectedOwner.toLowerCase())) reject();
    validateLoginPermissions(permissions, true);
    if (!Array.isArray(selection.permissions) || !same(resolvePermissions(permissions, selection.ownerDid), canonicalPermissions(selection.permissions as AppReadPermission[]))) reject();
    return registryReadPermissions(selection.ownerDid);
  } catch { reject(); }
}

export function appReadExpiryLimit(expiry: string | number = '7d'): number {
  try {
    const milliseconds = typeof expiry === 'number' ? expiry : parseExpiry(expiry);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 60000) throw new Error();
    return milliseconds;
  } catch {
    throw new CLIError('INVALID_EXPIRY', 'App-read expiry must be at least one minute and a finite duration.', ExitCode.USAGE_ERROR);
  }
}

async function readApplication(data: Record<string, unknown>, key: object, host: string, appId: string): Promise<RegisteredReadApp> {
  const { TinyCloudNode } = await import('@tinycloud/node-sdk');
  const node = new TinyCloudNode({ host });
  // Restore only in memory. No sign-in, bootstrap, registration or disk install.
  await node.restoreSession({
    delegationHeader: data.delegationHeader as { Authorization: string }, delegationCid: data.delegationCid as string,
    spaceId: data.spaceId as string, jwk: key, verificationMethod: data.verificationMethod as string,
    address: data.address as string, chainId: data.chainId as number, siwe: data.siwe as string,
    signature: data.signature as string, tinycloudHosts: [host],
  });
  const result = await node.account.applications.get(appId);
  if (!result.ok) throw new CLIError('OPENKEY_DISCOVERY_UNAVAILABLE', 'The approved application could not be read from its canonical registry. No session was saved.', ExitCode.AUTH_REQUIRED);
  return result.data;
}

/** Verify a single owner approval against the actual registry before installing
 * it. Unsigned discovery metadata is only a selector, never scope authority. */
export async function verifyDiscoveredAppLogin(
  data: Record<string, unknown>, key: object, sessionDid: string, registry: PermissionEntry[], host: string, expectedOwner?: string,
  dependencies: { loadApplication?: typeof readApplication; requestedExpiry?: string | number } = {},
): Promise<Record<string, unknown>> {
  const selection = data.appReadSelection as Record<string, unknown> | undefined;
  const publicKey = key as Record<string, unknown>;
  if (!selection || selection.schemaVersion !== 1 || selection.protocolVersion !== APP_READ_PROTOCOL_VERSION || typeof selection.appId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selection.appId) || typeof selection.ownerDid !== 'string' ||
      selection.host !== host || typeof selection.manifestHash !== 'string' || typeof selection.selectionDigest !== 'string') reject();
  if (selection.clientKeyDigest !== sha256(publicClientKey({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x }))) reject();
  const owner = selection.ownerDid as string;
  validateAppReadRegistryPermissions(registry, owner);

  // First verify the signed scope against a bounded read-only ceiling. This is
  // sufficient to read the registry, but is not yet sufficient to save a grant.
  const claimed = selection.permissions;
  if (!Array.isArray(claimed) || claimed.length > 256) reject();
  validateLoginPermissions(claimed, true);
  const registryScope = registryReadPermissions(owner);
  const actions: Record<string, string[]> = { 'tinycloud.kv': ['tinycloud.kv/get', 'tinycloud.kv/list', 'tinycloud.kv/metadata'], 'tinycloud.sql': ['tinycloud.sql/read'] };
  for (const entry of claimed as AppReadPermission[]) {
    let space: string;
    try { space = ownerSpace(owner, entry.space); } catch { reject(); }
    if (space.endsWith(':account')) {
      const allowed = registryScope.find(p => p.service === entry.service && p.path === entry.path);
      if (!allowed || entry.actions.some(a => !allowed.actions.includes(a))) reject('OPENKEY_GRANT_BROADENED');
    } else if (space.endsWith(':public') || space.endsWith(':secrets')) reject('OPENKEY_GRANT_BROADENED');
    else if (entry.service === 'tinycloud.capabilities') {
      if (entry.path !== '' || entry.actions.some(a => a !== 'tinycloud.capabilities/read')) reject('OPENKEY_GRANT_BROADENED');
    } else if (!actions[entry.service] || entry.actions.some(a => !actions[entry.service]!.includes(a)) ||
      !entry.path || entry.path === '/' || entry.path.length > 4096 || entry.path.includes('*') || entry.path.includes('\0') || entry.path.split('/').some(p => p === '.' || p === '..')) reject('OPENKEY_GRANT_BROADENED');
  }
  const preliminary = await verifyScopedLogin(data, key, sessionDid, claimed, expectedOwner ?? owner, true);
  const issuedAt = Date.parse(new SiweMessage(preliminary.siwe as string).issuedAt);
  const lifetime = Date.parse(preliminary.expiresAt as string) - issuedAt;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > appReadExpiryLimit(dependencies.requestedExpiry) + 1000) reject('OPENKEY_GRANT_BROADENED');
  if ((preliminary.ownerDid as string).toLowerCase() !== owner.toLowerCase()) reject();
  const application = await (dependencies.loadApplication ?? readApplication)(preliminary, key, host, selection.appId as string);
  let expected: ReturnType<typeof appReadSelection>;
  try {
    if (application.appId !== selection.appId || hashApplicationManifests(application.manifests) !== application.manifestHash) reject();
    expected = appReadSelection(application, { ownerDid: owner, host, jwk: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x } });
  } catch { reject(); }
  if (!same(expected, selection)) reject();
  const verified = await verifyScopedLogin(data, key, sessionDid, expected.permissions, expectedOwner ?? owner, true);
  return { ...verified, appReadSelection: expected };
}
