import { randomBytes } from "node:crypto";
import type { CliClient } from "../contracts/client";
import type { Scenario, ScenarioContext } from "../contracts/scenario";
import type { TopologySpec } from "../contracts/topology";
import { registerScenarios } from "../runner/registry";
import { createCliDelegation } from "./cli-delegation";

const PREFIX = "notes/";
const key = `${PREFIX}a.txt`;
const ACTIONS = ["get", "list", "metadata", "sync"] as const;

const DELEGATION_ENDPOINT = "http://127.0.0.1:40123";
function readerProxy(ctx: ScenarioContext) {
  const endpoint = ctx.topo.spec.clients.find((client) => client.id === "reader")?.endpoint;
  if (!endpoint) return ctx.topo.proxy("client:reader->a");
  const url = new URL(endpoint);
  return ctx.topo.proxy(`shared:${url.hostname}:${url.port}`);
}
function topology(): TopologySpec {
  return {
    name: "core-08",
    nodes: [{ id: "a" }],
    clients: [
      { id: "owner", kind: "cli", node: "a", identity: "owner", endpoint: DELEGATION_ENDPOINT, auth: { posture: "owner" }, replication: { prefixes: [PREFIX] } },
      { id: "reader", kind: "cli", node: "a", identity: "owner", endpoint: DELEGATION_ENDPOINT, auth: { posture: "delegate-session", grant: {
        issuer: "owner", caps: [{ prefix: PREFIX, actions: ["get", "list", "metadata", "sync"] }], expiresInMs: 30 * 24 * 60 * 60_000,
      } }, replication: { prefixes: [PREFIX], maxStalenessMs: 0 } },
    ],
  };
}
function opEvents(result: { events: { attribution: string; event: { type: string; [field: string]: unknown } }[] }) {
  return result.events.filter((item) => item.attribution === "op").map((item) => item.event);
}
function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>; } catch { return {}; }
}
const scenario: Scenario<"cli"> = {
  id: "CORE-08", title: "Revoked grant is discovered and purged", tier: "core", variants: ["cli"], timeoutMs: 150_000,
  topology: () => topology(),
  async run(ctx) {
    const owner = ctx.topo.cli("owner");
    const reader = ctx.topo.cli("reader");
    const sentinel = randomBytes(32);
    const put = await owner.put(key, sentinel, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("owner writes sentinel before delegation", put.ok && put.outcome === "committed", { ok: put.ok, outcome: put.outcome });
    const space = put.events.find((item) => item.event.type === "replication.write")?.event.space;
    ctx.check("owner write reports its authority space", typeof space === "string");
    if (typeof space !== "string") throw new Error("owner write did not report its space");
    const delegation = await createCliDelegation(owner, reader, { space, prefix: PREFIX, actions: ACTIONS, expires: "30d" });
    ctx.check("delegation CID is available to revoke", typeof delegation.cid === "string" && delegation.cid.length > 0);
    if (!delegation.cid) throw new Error("CLI grant response did not expose a delegation CID");
    const warm = await reader.get(key, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("delegate serves a warm replica hit", warm.ok && warm.found && warm.read?.source === "replica" && warm.read.reason === "hit", warm.read);
    const revoke = await owner.tc(["delegation", "revoke", delegation.cid, "--yes"], { signal: ctx.signal });
    ctx.check("owner revokes device grant", revoke.exit === 0, { exit: revoke.exit, stderr: revoke.stderr });

    const afterRevoke = await reader.get(key, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    const attributed = opEvents(afterRevoke);
    const discovery = attributed.some((event) => event.type === "replication.sync" && event.outcome === "error" && event.code === "GRANT_REVOKED") ||
      attributed.some((event) => event.type === "replication.read" && (event.reason === "grant_revoked" || event.reason === "stale" && event.code === "GRANT_REVOKED")) ||
      attributed.some((event) => event.type === "replication.state" && event.state === "revoked");
    const forcedStaleReadSync = attributed.some((event) => event.type === "replication.sync" && event.trigger === "stale_read");
    const servedLocally = afterRevoke.read?.source === "replica" || attributed.some((event) => event.type === "replication.read" && event.source === "replica");
    ctx.check("post-revoke stale read forces discovery and is not served locally", forcedStaleReadSync && discovery && !servedLocally, { ok: afterRevoke.ok, result: afterRevoke.read, events: attributed });

    const scanClient = reader as CliClient & { scanReplica(needle: Uint8Array): Promise<string[]>; replicaDir(): string };
    const report = async () => {
      const result = await reader.tc(["replica", "report", "--json"], { signal: ctx.signal });
      return { exit: result.exit, json: parseJson(result.stdout) };
    };
    const end = ctx.clock.now() + 10_000;
    let lastReport: { exit: number | null; json: Record<string, unknown> } | undefined;
    let lastResidual: string[] = [];
    let purged = false;
    while (ctx.clock.now() < end) {
      const state = await report();
      const entries: unknown[] = Array.isArray(state.json.replicas) ? state.json.replicas : Array.isArray(state.json.prefixes) ? state.json.prefixes : [];
      const revokedOrAbsent = state.exit === 0 && !entries.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).prefix === PREFIX && (entry as Record<string, unknown>).state !== "revoked");
      lastReport = state;
      const residual = await scanClient.scanReplica(sentinel);
      lastResidual = residual;
      if (revokedOrAbsent && residual.length === 0) { purged = true; break; }
      await ctx.clock.sleep(100, ctx.signal);
    }
    await readerProxy(ctx).disable({ signal: ctx.signal });
    const offline = await reader.get(key, { signal: ctx.signal });
    ctx.check("fresh invocation offline does not serve revoked local data", offline.exit !== 0 && offline.read?.source !== "replica" && offline.ok === false, { exit: offline.exit, ok: offline.ok, read: offline.read, code: offline.code });
    ctx.check("revoked prefix is absent or revoked and sentinel is purged", purged, { replicaDir: scanClient.replicaDir(), report: lastReport, residual: lastResidual });
  },
};

registerScenarios(scenario);
