import { extractSiweExpiration } from '@tinycloud/node-sdk';
import type { PermissionEntry } from '@tinycloud/node-sdk';
import { CourierError } from './errors.js';
import { AGENT_GRANT, AGENT_GRANT_EXPIRY, peerReadPermissions, REVOKE_GRANT_ENTRY } from './keys.js';
import { PEER_DELEGATION_EXPIRY } from './pairing.js';

const DAY_MS = 24 * 3600 * 1000;

/** `30d`/`7d`/`1h` → ms; undefined when not `<int><s|m|h|d>`. */
export function durationMs(value: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return undefined;
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[match[2] as 's' | 'm' | 'h' | 'd'];
  const duration = Number(match[1]) * factor;
  return Number.isFinite(duration) ? duration : undefined;
}

export const AGENT_GRANT_MAX_MS = durationMs(AGENT_GRANT_EXPIRY)!;
export const PEER_DELEGATION_MAX_MS = durationMs(PEER_DELEGATION_EXPIRY)!;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function bareDid(did: string): string {
  return did.split('#', 1)[0];
}

interface AuthorityTuple {
  service: string;
  space: string;
  path: string;
  action: string;
}

function authorityTuples(entries: readonly PermissionEntry[]): Map<string, AuthorityTuple> {
  const tuples = new Map<string, AuthorityTuple>();
  for (const entry of entries) {
    for (const action of entry.actions) {
      const tuple = { service: entry.service, space: (entry.space ?? '').toLowerCase(), path: entry.path, action };
      tuples.set(JSON.stringify([tuple.service, tuple.space, tuple.path, tuple.action]), tuple);
    }
  }
  return tuples;
}

function renderTuples(tuples: AuthorityTuple[]): string {
  const shown = tuples.slice(0, 3).map(({ service, space, path, action }) => `${service} ${space} ${path || '""'} ${action}`);
  if (tuples.length > 3) shown.push(`(+${tuples.length - 3} more)`);
  return shown.join('; ');
}

/**
 * Require the complete effective authority to equal an explicit allowlist. Tuples from `optional` may be present or
 * absent; anything else outside `allowed` is too broad, anything in `allowed` that is absent is incomplete.
 */
export function assertExactAuthority(signed: readonly PermissionEntry[], allowed: readonly PermissionEntry[], label: string, optional: readonly PermissionEntry[] = []): void {
  const signedTuples = authorityTuples(signed);
  const allowedTuples = authorityTuples(allowed);
  const optionalTuples = authorityTuples(optional);
  const extra = [...signedTuples].filter(([tuple]) => !allowedTuples.has(tuple) && !optionalTuples.has(tuple)).map(([, value]) => value);
  if (extra.length) {
    throw new CourierError('grant-too-broad', `${label} carries authority Courier does not allow: ${renderTuples(extra)}`);
  }
  const missing = [...allowedTuples].filter(([tuple]) => !signedTuples.has(tuple)).map(([, value]) => value);
  if (missing.length) {
    throw new CourierError('grant-incomplete', `${label} is missing ${renderTuples(missing)}`);
  }
}

/** Whether the signed authority includes the revoke entry (every action of it). */
export function grantCanRevoke(signed: readonly PermissionEntry[]): boolean {
  const signedTuples = authorityTuples(signed);
  return [...authorityTuples([REVOKE_GRANT_ENTRY]).keys()].every((tuple) => signedTuples.has(tuple));
}

function formatDays(ms: number): string {
  const days = (ms / DAY_MS).toFixed(2).replace(/\.?0+$/, '');
  return `${days} days`;
}

export function assertLifetime(label: string, expiresAt: Date | undefined, maxMs: number, now: number, issuedAt?: Date): void {
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
    throw new CourierError('bad-grant', `${label} has no signed expiry.`);
  }
  const expiry = expiresAt.getTime();
  if (expiry <= now) throw new CourierError('grant-expired', `${label} has expired.`);
  if (issuedAt !== undefined) {
    const issued = issuedAt.getTime();
    if (!Number.isFinite(issued) || issued > now + CLOCK_SKEW_MS) {
      throw new CourierError('bad-grant', `${label} was issued in the future or has an invalid Issued At.`);
    }
    if (expiry - issued > maxMs + CLOCK_SKEW_MS) {
      throw new CourierError('grant-too-long', `${label} is valid for ${formatDays(expiry - issued)}; Courier accepts at most ${formatDays(maxMs).replace(/ days$/, '')}.`);
    }
  }
  if (expiry - now > maxMs + CLOCK_SKEW_MS) {
    throw new CourierError('grant-too-long', `${label} is valid for ${formatDays(expiry - now)}; Courier accepts at most ${formatDays(maxMs).replace(/ days$/, '')}.`);
  }
}

export function siweTimes(siwe: string): { issuedAt?: Date; expiresAt?: Date } {
  const issued = /^Issued At:\s*(.+)$/m.exec(siwe)?.[1];
  const expiresAt = extractSiweExpiration(siwe);
  return {
    ...(issued !== undefined ? { issuedAt: new Date(issued.trim()) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function assertAgentGrant(caps: readonly PermissionEntry[], times: { issuedAt?: Date; expiresAt?: Date }, now = Date.now()): void {
  assertExactAuthority(caps, AGENT_GRANT.filter((entry) => entry !== REVOKE_GRANT_ENTRY), 'OpenKey grant', [REVOKE_GRANT_ENTRY]);
  if (!times.issuedAt) throw new CourierError('bad-grant', 'OpenKey grant SIWE is missing Issued At.');
  assertLifetime('OpenKey grant', times.expiresAt, AGENT_GRANT_MAX_MS, now, times.issuedAt);
}

export interface SignedPeerDelegation {
  audience: string;
  expiry: Date;
  effectivePermissions: readonly PermissionEntry[];
  delegation: { delegatorDID?: string };
}

export interface ExpectedPeerDelegation {
  issuer: string;
  audience: string;
  spaceId: string;
  mailbox: string;
}

export function assertPeerDelegation(active: SignedPeerDelegation, expected: ExpectedPeerDelegation, now = Date.now()): void {
  const issuer = bareDid(active.delegation.delegatorDID ?? '');
  if (issuer !== expected.issuer) {
    throw new CourierError('bad-delegation', `Peer delegation is signed by ${issuer || 'an unknown issuer'}, not the advertised courier ${expected.issuer}.`);
  }
  if (bareDid(active.audience) !== expected.audience) {
    throw new CourierError('bad-delegation', `Peer delegation audience ${active.audience} does not match ${expected.audience}.`);
  }
  assertExactAuthority(active.effectivePermissions, peerReadPermissions(expected.mailbox, expected.spaceId), 'Peer delegation');
  assertLifetime('Peer delegation', active.expiry, PEER_DELEGATION_MAX_MS, now);
}
