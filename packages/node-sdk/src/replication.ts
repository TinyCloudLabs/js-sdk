import type { TinyCloudReplicationSession } from "./TinyCloudNode";

export interface ReplicationNotifyRequest {
  spaceId: string;
  service: "kv" | "sql";
  prefix?: string;
  dbName?: string;
  lastSeenSeq?: number;
  timeoutMs?: number;
}

export interface ReplicationNotifyResponse {
  spaceId: string;
  service: "kv" | "sql";
  prefix?: string;
  dbName?: string;
  lastSeenSeq?: number;
  latestSeq: number;
  dirty: boolean;
  timedOut: boolean;
}

export interface ReplicationPullSessions {
  target: TinyCloudReplicationSession;
  peer: TinyCloudReplicationSession;
}

export interface ReplicationKvReconcileRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface ReplicationKvReconcileResponse {
  spaceId: string;
  requestedSinceSeq?: number;
  peerUrl?: string;
  appliedSequences: number;
  appliedEvents: number;
  appliedUntilSeq?: number;
}

export interface ReplicationSqlReconcileRequest {
  peerUrl: string;
  spaceId: string;
  dbName: string;
  sinceSeq?: number;
}

export interface ReplicationSqlReconcileResponse {
  spaceId: string;
  dbName: string;
  peerUrl?: string;
  mode?: "snapshot" | "changeset";
  snapshotReason?: string | null;
  changesetBytes?: number;
  snapshotBytes?: number;
  appliedUntilSeq?: number;
}

export interface ReplicationSessionOpenResponse {
  sessionToken: string;
  spaceId: string;
  service: string;
  serverDid: string;
  rolesEnabled: string[];
  peerServing: boolean;
  canExport: boolean;
  recon: boolean;
  authSync: boolean;
  prefix?: string;
  dbName?: string;
  expiresAt: string;
}

export interface RequestTransportSessionOptions {
  supportingDelegations?: string[] | null;
}

function normalizeHeaders(
  headers: Record<string, string> | [string, string][]
): Record<string, string> {
  return Array.isArray(headers) ? Object.fromEntries(headers) : { ...headers };
}

const transportSessionCache = new WeakMap<
  TinyCloudReplicationSession,
  ReplicationSessionOpenResponse
>();

function transportSessionIsFresh(
  session: ReplicationSessionOpenResponse | undefined
): session is ReplicationSessionOpenResponse {
  if (!session) {
    return false;
  }

  return new Date(session.expiresAt).getTime() > Date.now() + 1_000;
}

export async function requestTransportSession(
  session: TinyCloudReplicationSession | undefined,
  options: RequestTransportSessionOptions = {}
): Promise<Response | undefined> {
  if (!session) {
    return undefined;
  }

  const body =
    session.scope.service === "auth"
      ? {
          spaceId: session.spaceId,
          service: "auth",
          prefix: null,
          dbName: null,
        }
      : session.scope.service === "kv"
        ? {
            spaceId: session.spaceId,
            service: "kv",
            prefix: session.scope.prefix,
          }
        : {
            spaceId: session.spaceId,
            service: "sql",
            dbName: session.scope.dbName,
          };

  const supportingDelegations =
    options.supportingDelegations === undefined
      ? session.supportingDelegations
      : options.supportingDelegations;
  const requestBody =
    supportingDelegations === null
      ? body
      : {
          ...body,
          supportingDelegations,
        };

  return fetch(`${session.host}/replication/session/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...normalizeHeaders(session.delegationHeader),
    },
    body: JSON.stringify(requestBody),
  });
}

export async function openTransportSession(
  session: TinyCloudReplicationSession | undefined
): Promise<ReplicationSessionOpenResponse | undefined> {
  if (!session) {
    return undefined;
  }

  const cached = transportSessionCache.get(session);
  if (transportSessionIsFresh(cached)) {
    return cached;
  }

  const response = await requestTransportSession(session);
  if (!response?.ok) {
    throw new Error(
      `Replication session open failed on ${session.host}: ${response?.status} ${await response?.text()}`
    );
  }

  const opened = (await response.json()) as ReplicationSessionOpenResponse;
  transportSessionCache.set(session, opened);
  return opened;
}

async function buildSessionHeaders(
  headerName: string,
  session: TinyCloudReplicationSession | undefined
): Promise<Record<string, string>> {
  const opened = await openTransportSession(session);
  return opened ? { [headerName]: opened.sessionToken } : {};
}

export async function notifyReplication(
  session: TinyCloudReplicationSession,
  request: ReplicationNotifyRequest
): Promise<ReplicationNotifyResponse> {
  const headers = await buildSessionHeaders("Replication-Session", session);
  const response = await fetch(`${session.host}/replication/notify/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Replication notify failed on ${session.host}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationNotifyResponse;
}

export async function reconcileKvReplication(
  target: TinyCloudReplicationSession,
  peer: TinyCloudReplicationSession,
  request: ReplicationKvReconcileRequest
): Promise<ReplicationKvReconcileResponse> {
  const targetHeaders = await buildSessionHeaders("Replication-Session", target);
  const peerHeaders = await buildSessionHeaders("Peer-Replication-Session", peer);
  const response = await fetch(`${target.host}/replication/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...targetHeaders,
      ...peerHeaders,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `KV replication reconcile failed on ${target.host}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationKvReconcileResponse;
}

export async function reconcileSqlReplication(
  target: TinyCloudReplicationSession,
  peer: TinyCloudReplicationSession,
  request: ReplicationSqlReconcileRequest
): Promise<ReplicationSqlReconcileResponse> {
  const targetHeaders = await buildSessionHeaders("Replication-Session", target);
  const peerHeaders = await buildSessionHeaders("Peer-Replication-Session", peer);
  const response = await fetch(`${target.host}/replication/sql/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...targetHeaders,
      ...peerHeaders,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `SQL replication reconcile failed on ${target.host}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationSqlReconcileResponse;
}
