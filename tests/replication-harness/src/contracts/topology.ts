import type { Backend, ClientKind } from "./common";

export type NodeImageRef = "default" | "previous" | "prod" | { ref: string } | { build: { path: string; ref?: string } };
export interface NodeSpec {
  id: string;
  role?: "hosted" | "local";
  backend?: Backend;
  image?: NodeImageRef;
  env?: Record<`TINYCLOUD_${string}`, string>;
}
export interface ReplicationSpec {
  prefixes: string[];
  allowSecrets?: boolean;
  mode?: "foreground" | "background";
  maxStalenessMs?: number;
  staleSyncTimeoutMs?: number;
  syncIntervalMs?: number;
  verify?: boolean;
}
export type KvAction = "get" | "list" | "metadata" | "sync" | "put" | "del";
export interface GrantCap { prefix: string; actions: KvAction[] }
export interface AuthSpec {
  posture: "owner" | "delegate-session";
  sessionExpiryMs?: number;
  grant?: { issuer: string; caps: GrantCap[]; expiresInMs: number };
  restore?: "persist" | "none";
}
export interface ClientSpec {
  id: string;
  kind: ClientKind;
  node: string;
  extraHosts?: { alias: string; node: string }[];
  identity: string;
  auth: AuthSpec;
  replication?: ReplicationSpec | false;
  preloads?: ("fetch-faults" | "node20")[];
}
export interface LinkSpec { from: string; to: string }
export interface TopologySpec { name: string; nodes: NodeSpec[]; clients: ClientSpec[]; links?: LinkSpec[] }

import { HarnessError } from "./common";
export function validateTopology(spec: TopologySpec): TopologySpec {
  const errors: string[] = [];
  const nodes = new Map<string, NodeSpec>();
  const ids = new Set<string>();
  const validId = (id: string) => /^[a-z0-9]{1,8}$/.test(id);
  for (const node of spec.nodes) {
    if (!validId(node.id)) errors.push(`invalid node id ${node.id}`);
    if (ids.has(node.id)) errors.push(`duplicate id ${node.id}`);
    ids.add(node.id); nodes.set(node.id, node);
  }
  for (const client of spec.clients) {
    if (!validId(client.id)) errors.push(`invalid client id ${client.id}`);
    if (ids.has(client.id)) errors.push(`duplicate id ${client.id}`);
    ids.add(client.id);
  }
  const aliases = new Set<string>();
  const declaredClients = new Map<string, ClientSpec>();
  for (const client of spec.clients) {
    if (!nodes.has(client.node)) errors.push(`client ${client.id} references unknown node ${client.node}`);
    for (const host of client.extraHosts ?? []) {
      if (!validId(host.alias) || ids.has(host.alias) || aliases.has(host.alias)) errors.push(`invalid or duplicate alias ${host.alias}`);
      aliases.add(host.alias);
      if (!nodes.has(host.node)) errors.push(`client ${client.id} references unknown node ${host.node}`);
    }
    const replication = client.replication;
    if (replication && replication.prefixes.length === 0) errors.push(`client ${client.id} has no replication prefixes`);
    if (replication) {
      const prefixes = [...replication.prefixes].sort();
      for (let i = 0; i < prefixes.length; i++) {
        if (!prefixes[i].endsWith("/")) errors.push(`client ${client.id} prefix ${prefixes[i]} must end in /`);
        if (i && prefixes[i].startsWith(prefixes[i - 1])) errors.push(`client ${client.id} has overlapping prefixes`);
      }
      if (client.kind === "cli" && (replication.mode !== undefined || replication.syncIntervalMs !== undefined)) errors.push(`CLI client ${client.id} has SDK-only replication options`);
    }
    if (client.kind === "cli" && client.auth.sessionExpiryMs !== undefined) errors.push(`CLI client ${client.id} cannot set session expiry`);
    if (client.auth.posture === "delegate-session") {
      const grant = client.auth.grant;
      if (!grant) errors.push(`client ${client.id} requires a grant`);
      else {
        const issuer = declaredClients.get(grant.issuer);
        if (!issuer || issuer.auth.posture !== "owner" || issuer.identity !== client.identity) errors.push(`client ${client.id} grant issuer must be an earlier owner of the same identity`);
        if (grant.expiresInMs < 60_000) errors.push(`client ${client.id} grant expiry must be at least 60000ms`);
      }
    } else if (client.auth.grant !== undefined) errors.push(`owner client ${client.id} cannot set a grant`);
    if (client.auth.sessionExpiryMs !== undefined && client.auth.sessionExpiryMs < 60_000) errors.push(`client ${client.id} session expiry must be at least 60000ms`);
    declaredClients.set(client.id, client);
  }
  for (const link of spec.links ?? []) if (!nodes.has(link.from) || !nodes.has(link.to)) errors.push(`link ${link.from}->${link.to} references unknown node`);
  if (errors.length) throw new HarnessError("TOPOLOGY_INVALID", errors.join("; "), { errors });
  return spec;
}
