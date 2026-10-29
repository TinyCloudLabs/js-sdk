import type { PermissionEntry } from '@tinycloud/node-sdk';

/** Courier KV layout and the single source of agent grant authority. */
export const PREFIX = 'xyz.tinycloud.courier';
export const EXT = 'https://tinycloud.xyz/ext/courier/v0';
export const DEFAULT_HOST = 'https://tee.node.tinycloud.xyz';
/** Must equal @tinycloud/bootstrap AGENTS_SPACE; created at TinyCloud onboarding, never by Courier. */
export const COURIER_SPACE = 'agents';
export const AGENT_GRANT_EXPIRY = '30d';

const kv = (path: string, actions: string[]): PermissionEntry => ({
  service: 'tinycloud.kv',
  space: COURIER_SPACE,
  path: `${PREFIX}/${path}`,
  actions: actions.map((action) => `tinycloud.kv/${action}`),
});

export const AGENT_GRANT: PermissionEntry[] = [
  kv('to/', ['get', 'put', 'list', 'del', 'metadata']),
  kv('me/requests/', ['put']),
  kv('me/mirror/', ['get', 'put', 'list', 'del']),
  kv('me/state/', ['get', 'put', 'list', 'del']),
  // Used-markers for approvals: no del, so a consumed approval cannot be un-consumed with the courier key (spec §7).
  kv('me/consumed/', ['get', 'put', 'list']),
  kv('me/peers/', ['get', 'put', 'list', 'del']),
  kv('me/', ['get', 'list']),
  {
    service: 'tinycloud.hooks',
    space: COURIER_SPACE,
    path: `kv/${PREFIX}/`,
    actions: ['tinycloud.hooks/subscribe'],
  },
];


export const k = {
  /** `to/<peer>/` — everything this side exposes to a peer. */
  toPeer: (peer: string) => `${PREFIX}/to/${peer}/`,
  threadRoot: (peer: string, threadId: string) => `${PREFIX}/to/${peer}/threads/${threadId}`,
  threadMeta: (peer: string, threadId: string) => `${k.threadRoot(peer, threadId)}/meta.json`,
  msgPrefix: (peer: string, threadId: string) => `${k.threadRoot(peer, threadId)}/msg/`,
  msg: (peer: string, threadId: string, messageId: string) => `${k.msgPrefix(peer, threadId)}${messageId}.json`,
  task: (peer: string, threadId: string, taskId: string) => `${k.threadRoot(peer, threadId)}/task/${taskId}.json`,
  file: (peer: string, threadId: string, name: string) => `${k.threadRoot(peer, threadId)}/files/${name}`,
  receipts: (peer: string) => `${k.toPeer(peer)}receipts.json`,
  peerDelegation: (peer: string, sessionId?: string) => `${sessionId ? `${k.threadRoot(peer, sessionId)}/` : k.toPeer(peer)}pairing/delegation.json`,
  peerRecord: (peer: string) => `${PREFIX}/me/peers/${peer}.json`,
  orders: (peer: string) => `${PREFIX}/me/orders/${peer}.md`,
  request: (id: string) => `${PREFIX}/me/requests/${id}.json`,
  approval: (id: string) => `${PREFIX}/me/approvals/${id}.json`,
  mirrorMsg: (peer: string, threadId: string, messageId: string) =>
    `${PREFIX}/me/mirror/${peer}/threads/${threadId}/msg/${messageId}.json`,
  mirrorMeta: (peer: string, threadId: string) =>
    `${PREFIX}/me/mirror/${peer}/threads/${threadId}/meta.json`,
  mirrorTask: (peer: string, threadId: string, taskId: string) =>
    `${PREFIX}/me/mirror/${peer}/threads/${threadId}/task/${taskId}.json`,
  watchState: `${PREFIX}/me/state/watch.json`,
  /** `me/state/paused/<peer>/<thread>.json`: this side's agent is not woken for the thread (written by the watcher on budget, or by `courier pause`). */
  paused: (peer: string, threadId: string) => `${PREFIX}/me/state/paused/${peer}/${threadId}.json`,
  pausedPrefix: `${PREFIX}/me/state/paused/`,
  /** Single-use marker for an approval (create-only). `me/consumed/` is get/put/list for the courier key, never del. */
  approvalUsed: (id: string) => `${PREFIX}/me/consumed/${id}.json`,
  /** One create-only marker per wake (see Watcher.claimWake). */
  wakeClaim: (peer: string, threadId: string, firstId: string) => `${PREFIX}/me/state/wake-claims/${peer}/${threadId}/${firstId}.json`,
  wakeClaimsPrefix: `${PREFIX}/me/state/wake-claims/`,
  peersPrefix: `${PREFIX}/me/peers/`,
  mirrorPrefix: `${PREFIX}/me/mirror/`,
  approvalsPrefix: `${PREFIX}/me/approvals/`,
  ordersPrefix: `${PREFIX}/me/orders/`,
  mePrefix: `${PREFIX}/me/`,
};

/** Peer-read capability entries for `delegateTo`, spec §3/§5 and TC-708. */
export function peerReadPermissions(peer: string, space: string, sessionId?: string): PermissionEntry[] {
  const root = sessionId ? `${k.threadRoot(peer, sessionId)}/` : k.toPeer(peer);
  return [
    { space, service: 'tinycloud.kv', path: root, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] },
    { space, service: 'tinycloud.hooks', path: `kv/${root.replace(/\/$/, '')}`, actions: ['tinycloud.hooks/subscribe'] },
  ];
}
