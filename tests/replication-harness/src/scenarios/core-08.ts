import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliClient } from "../contracts/client";
import type { Scenario, ScenarioContext } from "../contracts/scenario";
import type { TopologySpec } from "../contracts/topology";
import { registerScenarios } from "../runner/registry";

const PREFIX = "notes/";
const key = `${PREFIX}a.txt`;
const DEVICE_CAP = `tinycloud.kv:`;

function topology(): TopologySpec {
  return {
    name: "core-08",
    nodes: [{ id: "a" }],
    clients: [
      { id: "owner", kind: "cli", node: "a", identity: "owner", auth: { posture: "owner" }, replication: false },
      { id: "reader", kind: "cli", node: "a", identity: "owner", auth: { posture: "delegate-session", grant: {
        issuer: "owner", caps: [{ prefix: PREFIX, actions: ["get", "list", "metadata", "sync"] }], expiresInMs: 30 * 24 * 60 * 60_000,
      } }, replication: { prefixes: [PREFIX], maxStalenessMs: 0 } },
    ],
  };
}
function parseJson(value: Uint8Array): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(value).toString("utf8")) as Record<string, unknown>; } catch { return {}; }
}
function findCid(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(findCid).find((item) => item !== undefined);
  if (typeof value !== "object" || value === null) return undefined;
  for (const [name, nested] of Object.entries(value)) {
    if (/^(cid|delegationCid|grantCid)$/i.test(name) && typeof nested === "string") return nested;
    const found = findCid(nested);
    if (found) return found;
  }
  return undefined;
}
function opEvents(result: { events: { attribution: string; event: { type: string; [field: string]: unknown } }[] }) {
  return result.events.filter((item) => item.attribution === "op").map((item) => item.event);
}
const scenario: Scenario<"cli"> = {
  id: "CORE-08", title: "Revoked grant is discovered and purged", tier: "core", variants: ["cli"], timeoutMs: 150_000,
  topology: () => topology(),
  async run(ctx) {
    const owner = ctx.topo.cli("owner");
    const reader = ctx.topo.cli("reader");
    const sentinel = randomBytes(32);
    const initialize = await owner.tc(["init", "--name", owner.profile(), "--key-only"], { signal: ctx.signal });
    ctx.check("owner key-only initialization succeeds", initialize.exit === 0, { exit: initialize.exit, stderr: initialize.stderr });
    const login = await owner.tc(["auth", "login", "--method", "local"], { signal: ctx.signal });
    ctx.check("owner local login succeeds", login.exit === 0, { exit: login.exit, stderr: login.stderr });
    const put = await owner.put(key, sentinel, { signal: ctx.signal });
    ctx.check("owner writes sentinel before delegation", put.ok && put.outcome === "committed", { ok: put.ok, outcome: put.outcome });
    const space = put.events.find((item) => item.event.type === "replication.write")?.event.space;
    ctx.check("owner write reports its authority space", typeof space === "string");
    if (typeof space !== "string") throw new Error("owner write did not report its space");
    const requestPath = join(reader.home(), ".tc893-core08-request.json");
    const grantPath = join(owner.home(), ".tc893-core08-grant.json");
    const requested = await reader.tc(["init", "--name", reader.profile(), "--key-only"], { signal: ctx.signal });
    ctx.check("device key-only initialization succeeds", requested.exit === 0, { exit: requested.exit, stderr: requested.stderr });
    const request = await reader.tc(["auth", "request", "--cap", `${DEVICE_CAP}${space}:${PREFIX}:get,list,metadata,sync`, "--expiry", "30d", "--emit", requestPath], { signal: ctx.signal });
    ctx.check("device requests limited grant", request.exit === 0, { exit: request.exit, stderr: request.stderr });
    const grant = await owner.tc(["auth", "grant", "--yes", requestPath], { signal: ctx.signal });
    ctx.check("owner grants device", grant.exit === 0, { exit: grant.exit, stderr: grant.stderr });
    await writeFile(grantPath, grant.stdout, { mode: 0o600 });
    const imported = await reader.tc(["auth", "import", grantPath], { signal: ctx.signal });
    ctx.check("device imports grant", imported.exit === 0, { exit: imported.exit, stderr: imported.stderr });
    const warm = await reader.get(key, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("delegate serves a warm replica hit", warm.ok && warm.found && warm.read?.source === "replica" && warm.read.reason === "hit", warm.read);

    const cid = findCid(parseJson(grant.stdout));
    ctx.check("grant CID is available for revoke", typeof cid === "string" && cid.length > 0);
    if (!cid) throw new Error("grant response did not expose a CID for revoke");
    const revoke = await owner.tc(["delegation", "revoke", cid, "--yes"], { signal: ctx.signal });
    ctx.check("owner revokes device grant", revoke.exit === 0, { exit: revoke.exit, stderr: revoke.stderr });

    const afterRevoke = await reader.get(key, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    const attributed = opEvents(afterRevoke);
    const discovery = attributed.some((event) => event.type === "replication.sync" && event.outcome === "error" && event.code === "GRANT_REVOKED") ||
      attributed.some((event) => event.type === "replication.read" && (event.reason === "grant_revoked" || event.reason === "stale" && event.code === "GRANT_REVOKED")) ||
      attributed.some((event) => event.type === "replication.state" && event.state === "revoked");
    ctx.check("post-revoke stale read forces discovery and is not a replica hit", discovery && afterRevoke.read?.source !== "replica", { result: afterRevoke.read, events: attributed });

    const scanClient = reader as CliClient & { scanReplica(needle: Uint8Array): Promise<string[]>; replicaDir(): string };
    const report = async () => {
      const result = await reader.tc(["replica", "report", "--json"], { signal: ctx.signal });
      return { exit: result.exit, json: parseJson(result.stdout) };
    };
    const end = ctx.clock.now() + 10_000;
    let purged = false;
    while (ctx.clock.now() < end) {
      const state = await report();
      const entries = Array.isArray(state.json.replicas) ? state.json.replicas : Array.isArray(state.json.prefixes) ? state.json.prefixes : [];
      const revokedOrAbsent = state.exit === 0 && !entries.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).prefix === PREFIX && (entry as Record<string, unknown>).state !== "revoked");
      const residual = await scanClient.scanReplica(sentinel);
      if (revokedOrAbsent && residual.length === 0) { purged = true; break; }
      await ctx.clock.sleep(100, ctx.signal);
    }
    ctx.check("revoked prefix is absent or revoked and sentinel is purged", purged, { replicaDir: scanClient.replicaDir() });
    await ctx.topo.proxy("client:reader->a").disable({ signal: ctx.signal });
    const offline = await reader.get(key, { signal: ctx.signal });
    ctx.check("fresh invocation offline does not serve revoked local data", offline.exit !== 0 && offline.read?.source !== "replica" && offline.ok === false, { exit: offline.exit, ok: offline.ok, read: offline.read, code: offline.code });
  },
};

registerScenarios(scenario);
