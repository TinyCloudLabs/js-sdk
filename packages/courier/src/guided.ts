import { ulid } from 'ulid';
import type { TinyCloudNode, IKVService } from '@tinycloud/node-sdk';
import { CourierError } from './errors.js';
import { k, PREFIX } from './keys.js';
import { loadProfile, profileExists, profileDir, writeSecure, type Profile } from './profile.js';
import { courierNode, peerKv } from './node.js';
import { getJson, listAll, putCreate } from './store.js';
import { isRecord, type ThreadMeta } from './a2a.js';
import { requireFlag, type ParsedArgs } from './args.js';
import path from 'node:path';
import { joinInvitation } from './invitation.js';

export const INVITATION_MODES = ['same-owner', 'anyone', 'named'] as const;
export type InvitationMode = typeof INVITATION_MODES[number];
export interface CourierSession {
  sessionId: string;
  subject: string;
  createdAt: string;
  peer?: string;
}
const sessionPrefix = `${PREFIX}/me/state/sessions/`;
export const sessionKey = (id: string) => `${sessionPrefix}${id}.json`;
export const validSessionId = (id: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);

/** Discover persisted threads, not watcher processes or a machine-local recent list. */
export async function discoverSessions(node: TinyCloudNode, profile: Profile): Promise<CourierSession[]> {
  const found = new Map<string, CourierSession>();
  for (const key of await listAll(node.kv, sessionPrefix)) {
    const record = await getJson<CourierSession>(node.kv, key);
    if (record && validSessionId(record.value.sessionId) && key === sessionKey(record.value.sessionId)
      && typeof record.value.subject === 'string' && typeof record.value.createdAt === 'string') {
      found.set(record.value.sessionId, record.value);
    }
  }
  const scan = async (kv: IKVService, prefix: string, peer?: string) => {
    for (const key of await listAll(kv, prefix)) {
      const match = /\/threads\/([0-9A-HJKMNP-TV-Z]{26})\/meta\.json$/.exec(key);
      if (!match) continue;
      const got = await getJson<ThreadMeta>(kv, key);
      const meta = got?.value;
      if (!isRecord(meta) || meta.threadId !== match[1] || typeof meta.subject !== 'string' || typeof meta.createdAt !== 'string') continue;
      const handle = peer ?? /\/to\/([^/]+)\/threads\//.exec(key)?.[1];
      const identity = `${match[1]}:${handle ?? ''}`;
      // A draft and its first real thread are the same session.
      found.delete(match[1]);
      found.set(identity, { sessionId: match[1], subject: meta.subject, createdAt: meta.createdAt, ...(handle ? { peer: handle } : {}) });
    }
  };
  await scan(node.kv, `${PREFIX}/to/`);
  for (const peer of Object.values(profile.peers)) {
    if (peer.status !== 'paired' || !peer.inbound || !peer.theirHandleForMe) continue;
    const prefix = peer.sessionId ? `${k.threadRoot(peer.theirHandleForMe, peer.sessionId)}/` : `${k.toPeer(peer.theirHandleForMe)}threads/`;
    await scan(await peerKv(node, profile, peer), prefix, peer.handle);
  }
  return [...found.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId));
}

export function activateSession(session: CourierSession): void {
  writeSecure(path.join(profileDir(), 'active-session.json'), { v: 1, ...session });
}

export async function selectedSession(node: TinyCloudNode, profile: Profile, id: string, peer?: string): Promise<CourierSession> {
  if (!validSessionId(id)) throw new CourierError('usage', 'Session must be a Courier thread ID.');
  const matches = (await discoverSessions(node, profile)).filter((s) => s.sessionId === id && (peer === undefined || s.peer === peer));
  if (matches.length !== 1) throw new CourierError('session-not-found', 'The intended session is absent or ambiguous. Select its exact --session and --peer; no new session was created.');
  return matches[0];
}

export async function cmdStart(args: ParsedArgs): Promise<void> {
  // Incoming intent is handled before discovery or creation, including invalid links.
  const incoming = args.get('link') ?? args.positional[0];
  if (incoming) {
    return joinInvitation(incoming, args);
  }
  if (!profileExists()) {
    console.log(JSON.stringify({ status: 'setup-required', command: 'courier init', permissions: 'existing restricted Courier grant', invitationModes: INVITATION_MODES }));
    return;
  }
  const profile = loadProfile();
  const node = await courierNode(profile);
  if (args.has('session') && args.has('new')) throw new CourierError('usage', '--session and --new are mutually exclusive.');
  const sessions = await discoverSessions(node, profile);
  let session: CourierSession;
  if (args.has('session')) {
    session = await selectedSession(node, profile, requireFlag(args, 'session', 'courier start --session <id>'), args.get('peer'));
  } else if (sessions.length && !args.has('new')) {
    console.log(JSON.stringify({ status: 'choose-session', sessions, choices: ['new', 'existing'] }, null, 2));
    return;
  } else {
    const subject = args.has('new') ? requireFlag(args, 'new', 'courier start --new <subject>') : 'Courier chat';
    session = { sessionId: ulid(), subject, createdAt: new Date().toISOString() };
    await putCreate(node.kv, sessionKey(session.sessionId), session);
  }
  activateSession(session);
  console.log(JSON.stringify({ status: 'active', session, invitationModes: INVITATION_MODES }, null, 2));
}
