import { describe, expect, test } from 'bun:test';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { hashApplicationManifests } from '../../../sdk-core/src/account/applicationRecords.js';
import { appReadSelection, canonicalPermissions, registryReadPermissions } from './app-read-policy.js';
import { appReadExpiryLimit, validateAppReadRegistryPermissions, verifyDiscoveredAppLogin } from './app-read-discovery.js';

import * as appReadDiscovery from './app-read-discovery.js';

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner('4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f');
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const host = 'https://node.example.test';
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk('default')!);
const did = manager.getDID('default');
const jwk = { kty: key.kty, crv: key.crv, x: key.x };
const manifests = [{ app_id: 'measurements', name: 'Measurements', defaults: false, permissions: [
  { service: 'tinycloud.kv', space: 'default', path: 'measurements/', skipPrefix: true, actions: ['get', 'list', 'put'] },
  { service: 'tinycloud.sql', space: 'default', path: 'measurements', skipPrefix: true, actions: ['read', 'write'] },
] }];
const application = { appId: 'measurements', manifests, manifestHash: hashApplicationManifests(manifests) };
const selection = appReadSelection(application, { ownerDid, host, jwk });
const registry = registryReadPermissions(ownerDid);
async function signed(permissions = selection.permissions, expired = false) {
  const spaceAbilities: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const p of permissions) ((spaceAbilities[p.space] ??= {})[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const prepared = wasm.prepareSession({ abilities: {}, spaceAbilities, address, chainId: 1, domain: 'cli.example.test',
    spaceId: registry[0]!.space, jwk: key, issuedAt: new Date(Date.now() - 60000).toISOString(),
    expirationTime: new Date(Date.now() + (expired ? -30000 : 3600000)).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  return { ...wasm.completeSessionSetup({ ...prepared, signature }), address, chainId: 1, verificationMethod: did,
    siwe: prepared.siwe, signature, appReadSelection: selection, permissions, hostActivated: true };
}
function verify(data: Record<string, unknown>, loadApplication = async () => application) {
  return verifyDiscoveredAppLogin(data, key, did, registry, host, ownerDid, { loadApplication });
}
describe('one-approval discovered app verification', () => {
  test('fixed selections require the local key owner host and exact requested scope before approval', () => {
    expect(typeof appReadDiscovery.validateFixedAppReadSelection).toBe('function');
    const { validateFixedAppReadSelection } = appReadDiscovery;
    expect(validateFixedAppReadSelection(selection, key, selection.permissions, host, ownerDid)).toEqual(registry);
    for (const changed of [{ host: 'https://wrong.test' }, { protocolVersion: 2 }, { clientKeyDigest: '0'.repeat(64) }, { selectionDigest: '0'.repeat(64) }]) {
      expect(() => validateFixedAppReadSelection({ ...selection, ...changed }, key, selection.permissions, host, ownerDid)).toThrow();
    }
    expect(() => validateFixedAppReadSelection(selection, key, registry, host, ownerDid)).toThrow();
    expect(() => validateFixedAppReadSelection(selection, key, selection.permissions, host, 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111')).toThrow();
  });
  test('rejects wrong bootstrap scope before requesting browser approval', () => {
    expect(() => validateAppReadRegistryPermissions(registry)).not.toThrow();
    expect(() => validateAppReadRegistryPermissions(registry.map(p => ({ ...p, space: 'account' })))).not.toThrow();
    expect(() => validateAppReadRegistryPermissions([{ ...registry[1]!, path: '' }])).toThrow();
  });
  test('verifies one signature for registry plus canonical app reads before accepting the selected app', async () => {
    const data = await signed();
    let reads = 0;
    const result = await verify(data, async () => { reads++; return application; });
    expect(reads).toBe(1);
    expect(result.appReadSelection).toEqual(selection);
    expect(selection).toMatchObject({ protocolVersion: 1 });
    expect(canonicalPermissions(result.permissions as any)).toEqual(selection.permissions);
    expect(result.jwk).toEqual(key);
  });
  test('enforces the requested signed lifetime before a registry request', async () => {
    let reads = 0;
    const data = await signed();
    await expect(verifyDiscoveredAppLogin(data, key, did, registry, host, ownerDid, { requestedExpiry: '1m', loadApplication: async () => { reads++; return application; } })).rejects.toMatchObject({ code: 'OPENKEY_GRANT_BROADENED' });
    expect(reads).toBe(0);
    expect(appReadExpiryLimit('7d')).toBe(7 * 86400000);
    expect(() => appReadExpiryLimit('30s')).toThrow();
  });
  test('rejects signed writes before making a registry request', async () => {
    let reads = 0;
    const permissions = selection.permissions.map(p => p.service === 'tinycloud.sql' ? { ...p, actions: [...p.actions, 'tinycloud.sql/write'] } : p);
    await expect(verify(await signed(permissions), async () => { reads++; return application; })).rejects.toMatchObject({ code: 'OPENKEY_GRANT_BROADENED' });
    expect(reads).toBe(0);
  });
  test('rejects substituted selection, host and client key bindings', async () => {
    const data = await signed();
    for (const changed of [{ protocolVersion: undefined }, { protocolVersion: 2 }, { host: 'https://other.example.test' }, { clientKeyDigest: '0'.repeat(64) }, { appId: 'other' }]) {
      await expect(verify({ ...data, appReadSelection: { ...selection, ...changed } })).rejects.toMatchObject({ code: 'OPENKEY_DISCOVERY_MISMATCH' });
    }
  });
  test('rejects changed canonical registry manifests', async () => {
    await expect(verify(await signed(), async () => ({ ...application, manifests: [{ ...manifests[0]!, permissions: [] }] }))).rejects.toMatchObject({ code: 'OPENKEY_DISCOVERY_MISMATCH' });
  });
  test('rejects expired and wrong-key proofs without registry access', async () => {
    let reads = 0;
    const load = async () => { reads++; return application; };
    await expect(verify(await signed(undefined, true), load)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    const other = JSON.parse(wasm.createSessionManager().jwk('default')!);
    await expect(verifyDiscoveredAppLogin(await signed(), other, did, registry, host, ownerDid, { loadApplication: load })).rejects.toBeTruthy();
    expect(reads).toBe(0);
  });
  test('rejects incomplete scope and broad initial manifests', async () => {
    await expect(verify(await signed(registry))).rejects.toMatchObject({ code: 'OPENKEY_SCOPE_INCOMPLETE' });
    await expect(verifyDiscoveredAppLogin(await signed(), key, did, [{ ...registry[1]!, path: '' }], host, ownerDid)).rejects.toMatchObject({ code: 'INVALID_LOGIN_SCOPE' });
  });
});
