import { Wallet } from "ethers";
import {
  TinyCloudNode,
  type TinyCloudReplicationSession,
} from "@tinycloud/node-sdk";
import type { RunningCluster, RunningNode } from "./cluster";

export const REPLICATION_TEST_KEY =
  process.env.TC_TEST_PRIVATE_KEY ??
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface WaitForConditionOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface ReplicationReconcileRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface ReplicationExportRequest {
  spaceId: string;
  prefix?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface ReplicationExportResponse {
  spaceId: string;
  prefix?: string;
  requestedSinceSeq?: number;
  exportedUntilSeq?: number;
  sequences: unknown[];
}

export interface ReplicationApplyResponse {
  spaceId: string;
  requestedSinceSeq?: number;
  peerUrl?: string;
  appliedSequences: number;
  appliedEvents: number;
  appliedUntilSeq?: number;
}

export interface SqlReplicationReconcileRequest {
  peerUrl: string;
  spaceId: string;
  dbName: string;
}

function replicationDefaultActions(): Record<string, Record<string, string[]>> {
  return {
    space: {
      "": ["tinycloud.space/sync"],
    },
  };
}

export interface SqlReplicationApplyResponse {
  spaceId: string;
  dbName: string;
  peerUrl?: string;
  snapshotBytes: number;
}

export interface SqlReplicationExportRequest {
  spaceId: string;
  dbName: string;
}

export interface SqlReplicationExportResponse {
  spaceId: string;
  dbName: string;
  snapshot: number[];
}

export interface ReplicationSessionOpenResponse {
  sessionToken: string;
  spaceId: string;
  service: string;
  prefix?: string;
  dbName?: string;
  expiresAt: string;
}

export function getClusterNode(
  cluster: RunningCluster,
  nodeName: string
): RunningNode {
  const node = cluster.nodes.find((candidate) => candidate.name === nodeName);
  if (!node) {
    throw new Error(`Unknown cluster node: ${nodeName}`);
  }
  return node;
}

export function createClusterClient(
  cluster: RunningCluster,
  nodeName: string,
  prefix: string,
  key = REPLICATION_TEST_KEY
): TinyCloudNode {
  const node = getClusterNode(cluster, nodeName);
  return new TinyCloudNode({
    privateKey: key,
    host: node.url,
    prefix,
    autoCreateSpace: true,
    defaultActions: replicationDefaultActions(),
  });
}

export function createRandomClusterClient(
  cluster: RunningCluster,
  nodeName: string,
  prefix: string
): TinyCloudNode {
  return createClusterClient(
    cluster,
    nodeName,
    prefix,
    Wallet.createRandom().privateKey.slice(2)
  );
}

export async function waitForCondition(
  label: string,
  predicate: () => Promise<boolean>,
  options: WaitForConditionOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 250;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(pollMs);
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
}

export function uniqueReplicationPrefix(baseName: string): string {
  return `replication-${baseName}-${Date.now()}`;
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

  const body =
    session.scope.service === "kv"
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

  const response = await fetch(`${session.host}/replication/session/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...normalizeHeaders(session.delegationHeader),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Replication session open failed on ${session.host}: ${response.status} ${await response.text()}`
    );
  }

  const opened = (await response.json()) as ReplicationSessionOpenResponse;
  transportSessionCache.set(session, opened);
  return opened;
}

async function buildSessionHeaders(
  session: TinyCloudReplicationSession | undefined
): Promise<Record<string, string>> {
  const opened = await openTransportSession(session);
  return opened ? { "Replication-Session": opened.sessionToken } : {};
}

export async function exportFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: ReplicationExportRequest,
  session?: TinyCloudReplicationSession
): Promise<ReplicationExportResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders(session);
  const response = await fetch(`${node.url}/replication/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Replication export failed on ${sourceNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationExportResponse;
}

export async function reconcileFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: ReplicationReconcileRequest,
  session?: TinyCloudReplicationSession
): Promise<ReplicationApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const peerHeaders = await buildSessionHeaders(session);
  const response = await fetch(`${node.url}/replication/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...peerHeaders,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Replication reconcile failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationApplyResponse;
}

export async function reconcileSqlFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: SqlReplicationReconcileRequest,
  session?: TinyCloudReplicationSession
): Promise<SqlReplicationApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const peerHeaders = await buildSessionHeaders(session);
  const response = await fetch(`${node.url}/replication/sql/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...peerHeaders,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `SQL replication reconcile failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as SqlReplicationApplyResponse;
}

export async function openKvReplicationSession(
  client: TinyCloudNode,
  host: string,
  prefix?: string
): Promise<TinyCloudReplicationSession> {
  return client.openReplicationSession({
    host,
    scope: {
      service: "kv",
      prefix: prefix ?? "",
    },
  });
}

export async function openSqlReplicationSession(
  client: TinyCloudNode,
  host: string,
  dbName: string
): Promise<TinyCloudReplicationSession> {
  return client.openReplicationSession({
    host,
    scope: {
      service: "sql",
      dbName,
    },
  });
}

export async function exportSqlFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: SqlReplicationExportRequest,
  session?: TinyCloudReplicationSession
): Promise<SqlReplicationExportResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders(session);
  const response = await fetch(`${node.url}/replication/sql/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `SQL replication export failed on ${sourceNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as SqlReplicationExportResponse;
}
