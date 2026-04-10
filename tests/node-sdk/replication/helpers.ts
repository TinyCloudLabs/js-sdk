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

export interface AuthReplicationReconcileRequest {
  peerUrl: string;
  spaceId: string;
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

export interface AuthReplicationApplyResponse {
  spaceId: string;
  peerUrl?: string;
  importedDelegations: number;
  importedRevocations: number;
}

export interface SqlReplicationReconcileRequest {
  peerUrl: string;
  spaceId: string;
  dbName: string;
}

export interface ReplicationPullSessions {
  target: TinyCloudReplicationSession;
  peer: TinyCloudReplicationSession;
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

export interface KvReconExportRequest {
  spaceId: string;
  prefix?: string;
  startAfter?: string;
  limit?: number;
}

export interface KvStateRequest {
  spaceId: string;
  prefix?: string;
  keys: string[];
}

export interface KvStateStatusItem {
  key: string;
  status: "present" | "deleted" | "absent";
  seq?: number;
  invocationId?: string | null;
  deletedInvocationId?: string | null;
  valueHash?: string | null;
}

export interface KvStateResponse {
  spaceId: string;
  prefix?: string;
  items: KvStateStatusItem[];
}

export interface KvStateCompareRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  startAfter?: string;
  limit?: number;
}

export interface KvStateCompareItem {
  key: string;
  kind: string;
  localInvocationId?: string | null;
  peerStatus: "present" | "deleted" | "absent";
  peerSeq?: number | null;
  peerInvocationId?: string | null;
  peerDeletedInvocationId?: string | null;
  peerValueHash?: string | null;
}

export interface KvStateCompareResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  startAfter?: string;
  limit?: number;
  hasMore?: boolean;
  nextStartAfter?: string | null;
  items: KvStateCompareItem[];
}

export interface KvPeerMissingPlanItem {
  key: string;
  kind: string;
  localInvocationId?: string | null;
  peerStatus: "present" | "deleted" | "absent";
  peerSeq?: number | null;
  peerInvocationId?: string | null;
  peerDeletedInvocationId?: string | null;
  peerValueHash?: string | null;
  action: "keep" | "prune-delete" | "quarantine-absent";
}

export interface KvPeerMissingPlanResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  peerHostRole: boolean;
  startAfter?: string;
  limit?: number;
  hasMore?: boolean;
  nextStartAfter?: string | null;
  keepCount: number;
  pruneDeleteCount: number;
  quarantineAbsentCount: number;
  items: KvPeerMissingPlanItem[];
}

export interface KvPeerMissingQuarantineRequest {
  spaceId: string;
  prefix?: string;
  startAfter?: string;
  limit?: number;
}

export interface KvPeerMissingQuarantineItem {
  key: string;
  peerUrl: string;
  localInvocationId: string;
  peerStatus: "present" | "deleted" | "absent";
  peerInvocationId?: string | null;
  peerDeletedInvocationId?: string | null;
  quarantinedAt: number;
}

export interface KvPeerMissingQuarantineResponse {
  spaceId: string;
  prefix?: string;
  startAfter?: string;
  limit?: number;
  hasMore?: boolean;
  nextStartAfter?: string | null;
  items: KvPeerMissingQuarantineItem[];
}

export interface KvPeerMissingApplyItem {
  key: string;
  action: "keep" | "prune-delete" | "quarantine-absent";
  result: string;
  clearedQuarantine: boolean;
  localInvocationId?: string | null;
  peerStatus: "present" | "deleted" | "absent";
  peerDeletedInvocationId?: string | null;
  appliedSequences: number;
  appliedEvents: number;
}

export interface KvPeerMissingApplyResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  peerHostRole: boolean;
  startAfter?: string;
  limit?: number;
  hasMore?: boolean;
  nextStartAfter?: string | null;
  attemptedItems: number;
  prunedDeletes: number;
  quarantined: number;
  alreadyQuarantined: number;
  clearedQuarantine: number;
  kept: number;
  items: KvPeerMissingApplyItem[];
}

export interface KvReconItem {
  key: string;
  kind: string;
  invocationId?: string;
}

export interface KvReconExportResponse {
  spaceId: string;
  prefix?: string;
  hasMore?: boolean;
  nextStartAfter?: string | null;
  items: KvReconItem[];
}

export interface KvReconCompareRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  startAfter?: string;
  limit?: number;
}

export interface KvReconSplitRequest {
  spaceId: string;
  prefix?: string;
  childStartAfter?: string;
  childLimit?: number;
}

export interface KvReconSplitChild {
  prefix: string;
  itemCount: number;
  fingerprint: string;
  leaf: boolean;
}

export interface KvReconSplitResponse {
  spaceId: string;
  prefix?: string;
  childStartAfter?: string;
  childLimit?: number;
  itemCount: number;
  fingerprint: string;
  hasMore?: boolean;
  nextChildStartAfter?: string | null;
  children: KvReconSplitChild[];
}

export interface KvReconSplitCompareRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  childStartAfter?: string;
  childLimit?: number;
}

export interface KvReconSplitReconcileRequest {
  peerUrl: string;
  spaceId: string;
  prefix?: string;
  childStartAfter?: string;
  childLimit?: number;
  maxDepth?: number;
}

export interface KvReconSplitChildComparison {
  prefix: string;
  status: "match" | "local-missing" | "peer-missing" | "mismatch";
  localItemCount: number;
  peerItemCount: number;
  localFingerprint: string;
  peerFingerprint: string;
  leaf: boolean;
}

export interface KvReconSplitCompareResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  childStartAfter?: string;
  childLimit?: number;
  matches: boolean;
  hasMore?: boolean;
  nextChildStartAfter?: string | null;
  children: KvReconSplitChildComparison[];
}

export interface KvReconSplitReconcileChildResult {
  prefix: string;
  beforeStatus: "match" | "local-missing" | "peer-missing" | "mismatch";
  afterStatus: "match" | "local-missing" | "peer-missing" | "mismatch";
  appliedSequences: number;
  appliedEvents: number;
}

export interface KvReconSplitReconcileResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  childStartAfter?: string;
  childLimit?: number;
  matches: boolean;
  hasMore?: boolean;
  nextChildStartAfter?: string | null;
  attemptedChildren: number;
  reconciledChildren: number;
  children: KvReconSplitReconcileChildResult[];
}

export interface KvReconCompareResponse {
  spaceId: string;
  prefix?: string;
  peerUrl: string;
  matches: boolean;
  localItemCount: number;
  peerItemCount: number;
  localFingerprint: string;
  peerFingerprint: string;
  localHasMore?: boolean;
  peerHasMore?: boolean;
  localNextStartAfter?: string | null;
  peerNextStartAfter?: string | null;
  firstMismatchKey?: string | null;
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

  const response = await requestTransportSession(session);

  if (!response.ok) {
    throw new Error(
      `Replication session open failed on ${session.host}: ${response.status} ${await response.text()}`
    );
  }

  const opened = (await response.json()) as ReplicationSessionOpenResponse;
  transportSessionCache.set(session, opened);
  return opened;
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

async function buildSessionHeaders(
  headerName: string,
  session: TinyCloudReplicationSession | undefined
): Promise<Record<string, string>> {
  const opened = await openTransportSession(session);
  return opened ? { [headerName]: opened.sessionToken } : {};
}

export async function exportFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: ReplicationExportRequest,
  session?: TinyCloudReplicationSession
): Promise<ReplicationExportResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders("Replication-Session", session);
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
  sessions: ReplicationPullSessions
): Promise<ReplicationApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/reconcile`, {
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
      `Replication reconcile failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as ReplicationApplyResponse;
}

export async function reconcileAuthFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: AuthReplicationReconcileRequest,
  sessions: ReplicationPullSessions
): Promise<AuthReplicationApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/auth/reconcile`, {
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
      `Auth replication reconcile failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as AuthReplicationApplyResponse;
}

export async function reconcileSqlFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: SqlReplicationReconcileRequest,
  sessions: ReplicationPullSessions
): Promise<SqlReplicationApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/sql/reconcile`, {
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

export async function openAuthReplicationSession(
  client: TinyCloudNode,
  host: string
): Promise<TinyCloudReplicationSession> {
  return client.openReplicationSession({
    host,
    scope: {
      service: "auth",
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
  const headers = await buildSessionHeaders("Replication-Session", session);
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

export async function reconExportFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: KvReconExportRequest,
  session?: TinyCloudReplicationSession
): Promise<KvReconExportResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders("Replication-Session", session);
  const response = await fetch(`${node.url}/replication/recon/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `KV recon export failed on ${sourceNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvReconExportResponse;
}

export async function kvStateFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: KvStateRequest,
  session?: TinyCloudReplicationSession
): Promise<KvStateResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders("Replication-Session", session);
  const response = await fetch(`${node.url}/replication/kv/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `KV state export failed on ${sourceNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvStateResponse;
}

export async function kvStateCompareFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvStateCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvStateCompareResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/kv/state/compare`, {
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
      `KV state compare failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvStateCompareResponse;
}

export async function peerMissingPlanFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvStateCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvPeerMissingPlanResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/peer-missing/plan`, {
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
      `Peer-missing plan failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvPeerMissingPlanResponse;
}

export async function peerMissingApplyFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvStateCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvPeerMissingApplyResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/peer-missing/apply`, {
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
      `Peer-missing apply failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvPeerMissingApplyResponse;
}

export async function peerMissingQuarantineFromLocal(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvPeerMissingQuarantineRequest,
  session: TinyCloudReplicationSession
): Promise<KvPeerMissingQuarantineResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const headers = await buildSessionHeaders("Replication-Session", session);
  const response = await fetch(
    `${node.url}/replication/peer-missing/quarantine`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Peer-missing quarantine export failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvPeerMissingQuarantineResponse;
}

export async function reconSplitFromPeer(
  cluster: RunningCluster,
  sourceNodeName: string,
  request: KvReconSplitRequest,
  session?: TinyCloudReplicationSession
): Promise<KvReconSplitResponse> {
  const node = getClusterNode(cluster, sourceNodeName);
  const headers = await buildSessionHeaders("Replication-Session", session);
  const response = await fetch(`${node.url}/replication/recon/split`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `KV recon split failed on ${sourceNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvReconSplitResponse;
}

export async function reconSplitCompareFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvReconSplitCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvReconSplitCompareResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/recon/split/compare`, {
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
      `KV recon split compare failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvReconSplitCompareResponse;
}

export async function reconcileSplitFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvReconSplitReconcileRequest,
  sessions: ReplicationPullSessions
): Promise<KvReconSplitReconcileResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/reconcile/split`, {
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
      `KV split reconcile failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvReconSplitReconcileResponse;
}

export async function reconCompareFromPeer(
  cluster: RunningCluster,
  targetNodeName: string,
  request: KvReconCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvReconCompareResponse> {
  const node = getClusterNode(cluster, targetNodeName);
  const targetHeaders = await buildSessionHeaders(
    "Replication-Session",
    sessions.target
  );
  const peerHeaders = await buildSessionHeaders(
    "Peer-Replication-Session",
    sessions.peer
  );
  const response = await fetch(`${node.url}/replication/recon/compare`, {
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
      `KV recon compare failed on ${targetNodeName}: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()) as KvReconCompareResponse;
}
