// Kept in sync with OpenKey apps/api/src/services/app-read-policy.ts.
import { createHash } from 'node:crypto';
import { resolveManifest, type Manifest } from '../../../sdk-core/src/manifest.js';
import { ensureEip55 } from '@tinycloud/node-sdk-wasm';

export const APP_READ_PROTOCOL_VERSION = 1;

export interface AppReadPermission { service: string; space: string; path: string; actions: string[] }
export interface RegisteredReadApp { appId: string; manifests: Manifest[]; manifestHash?: string; name?: string; description?: string }
export const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
export const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const policyError = (code: string) => Object.assign(new Error(code), { code });

export function publicClientKey(jwk: unknown) {
  const value = jwk as Record<string, unknown> | null;
  if (!value || value.kty !== 'OKP' || value.crv !== 'Ed25519' || typeof value.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || 'd' in value) throw policyError('app_read_invalid_client_key');
  return { kty: 'OKP', crv: 'Ed25519', x: value.x };
}

export function ownerSpace(ownerDid: string, name: string) {
  const owner = /^did:pkh:eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40})$/.exec(ownerDid);
  if (!owner) throw policyError('app_read_invalid_owner');
  const canonical = `tinycloud:pkh:eip155:${owner[1]}:${ensureEip55(owner[2]!)}`;
  if (name.startsWith('tinycloud:')) {
    const match = /^(tinycloud:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}):([A-Za-z0-9_-]+)$/.exec(name);
    if (!match || match[1]!.toLowerCase() !== canonical.toLowerCase()) throw policyError('app_read_foreign_owner');
    return `${canonical}:${match[2]}`;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw policyError('app_read_invalid_space');
  return `${canonical}:${name}`;
}

export function canonicalPermissions(permissions: AppReadPermission[]) {
  const resources = new Map<string, AppReadPermission>();
  for (const entry of permissions) {
    const key = canonicalJson([entry.service, entry.space, entry.path]);
    const existing = resources.get(key) ?? { ...entry, actions: [] };
    existing.actions = [...new Set([...existing.actions, ...entry.actions])].sort();
    resources.set(key, existing);
  }
  return [...resources.values()].sort((a, b) => canonicalJson([a.service, a.space, a.path]).localeCompare(canonicalJson([b.service, b.space, b.path])));
}

export function registryReadPermissions(ownerDid: string): AppReadPermission[] {
  const space = ownerSpace(ownerDid, 'account');
  return [
    { service: 'tinycloud.capabilities', space, path: '', actions: ['tinycloud.capabilities/read'] },
    { service: 'tinycloud.kv', space, path: 'applications/', actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] },
  ];
}

/** Read only the selected app's explicitly declared resources. Bootstrap defaults
 * and secret access never become inferred permission requests. */
export function deriveAppReadPermissions(application: RegisteredReadApp, { ownerDid }: { ownerDid: string }): AppReadPermission[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(application.appId)) throw policyError('app_read_scope_unsupported');
  const permissions = registryReadPermissions(ownerDid);
  let dataResources = 0;
  const allowed: Record<string, string[]> = { 'tinycloud.kv': ['get', 'list', 'metadata'], 'tinycloud.sql': ['read'] };
  for (const manifest of application.manifests) {
    if (manifest.app_id !== application.appId) throw policyError('app_read_identity_mismatch');
    // sdk-core 2.6.1 can omit unrecognized restrictions during resolution.
    // Refuse them before projection instead of silently widening a grant.
    for (const raw of manifest.permissions ?? []) {
      const entry = raw as unknown as Record<string, unknown>;
      if (['caveats', 'constraints', 'conditions', 'expiry', 'expiryMs', 'expiresAt', 'expirationTime', 'notBefore'].some(field => entry[field] !== undefined)) throw policyError('app_read_scope_unsupported');
    }
    // Resolve only explicit resource entries. The declaration's original bytes
    // and canonical manifestHash are retained separately for verification.
    const resolved = resolveManifest({ ...manifest, defaults: false, includePublicSpace: false, secrets: undefined });
    for (const resource of resolved.resources) {
      const service = resource.service.startsWith('tinycloud.') ? resource.service : `tinycloud.${resource.service}`;
      if (!allowed[service]) continue;
      const actions = resource.actions.filter(action => allowed[service]!.includes(action.replace(`${service}/`, ''))).map(action => action.startsWith(`${service}/`) ? action : `${service}/${action}`);
      if (!actions.length) continue;
      const space = ownerSpace(ownerDid, resource.space);
      if (['account', 'secrets', 'public'].some(name => space.endsWith(`:${name}`)) || !resource.path || resource.path === '/' || resource.path.length > 4096 || resource.path.includes('*') || resource.path.includes('\0') || resource.path.split('/').some(p => p === '..' || p === '.')) throw policyError('app_read_scope_unsupported');
      const constraints = resource as unknown as Record<string, unknown>;
      if (constraints.caveats || constraints.constraints || constraints.conditions) throw policyError('app_read_scope_unsupported');
      permissions.push({ service, space, path: resource.path, actions });
      permissions.push({ service: 'tinycloud.capabilities', space, path: '', actions: ['tinycloud.capabilities/read'] });
      dataResources++;
    }
  }
  if (!dataResources) throw policyError('app_read_scope_unsupported');
  return canonicalPermissions(permissions);
}

export function appReadSelection(application: RegisteredReadApp, binding: { ownerDid: string; host: string; jwk: unknown }) {
  const clientKeyDigest = sha256(publicClientKey(binding.jwk));
  const permissions = deriveAppReadPermissions(application, binding);
  const details = { schemaVersion: 1, protocolVersion: APP_READ_PROTOCOL_VERSION, ownerDid: binding.ownerDid, host: binding.host, clientKeyDigest, appId: application.appId, manifestHash: application.manifestHash, permissions };
  return { ...details, selectionDigest: sha256(details) };
}
