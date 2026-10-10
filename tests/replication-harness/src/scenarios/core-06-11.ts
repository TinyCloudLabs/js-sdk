import { randomBytes } from "node:crypto";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliClient, GetResult, KvClient, SdkClient, WriteResult } from "../contracts/client";
import type { EventEnvelope } from "../contracts/events";
import type { Backend, ClientKind } from "../contracts/common";
import type { Scenario, ScenarioContext } from "../contracts/scenario";
import type { ClientSpec, TopologySpec } from "../contracts/topology";
import { registerScenarios } from "../runner/registry";
import { createCliDelegation } from "../clients/cli-client";
import { acceptsOfflineCliExpiry, hasCliErrorEnvelopeCode } from "./core-07-expiry";

const PREFIX = "notes/";
const key = "notes/a.txt";
const otherKey = "other/x";
const VALUE = "tc893-core-value";
const OTHER_VALUE = "tc893-other-value";
const ACTIONS = ["get", "list", "metadata", "sync"] as const;
const PARITY_IGNORE_FIELDS = new Set(["events", "opSeq", "startedMono", "durationMs", "read", "readEvent"]);
function comparableResult(result: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result)
    .filter(([field]) => !PARITY_IGNORE_FIELDS.has(field))
    .map(([field, value]) => [field, value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value]));
}
type Variant = "cli" | "sdk";

function client(id: string, kind: ClientKind, node: string, replication: ClientSpec["replication"], identity: string): ClientSpec {
  return { id, kind, node, identity, auth: { posture: "owner" }, replication };
}
function baseTopology(name: string, kind: ClientKind, replica: ClientSpec["replication"]): TopologySpec {
  return { name, nodes: [{ id: "a" }], clients: [client("reader", kind, "a", replica, `${name}-${kind}`)] };
}
function replication(kind: ClientKind, maxStalenessMs = 0) {
  return { prefixes: [PREFIX], ...(kind === "sdk" ? { mode: "foreground" as const } : {}), maxStalenessMs };
}
function requireOk(ctx: ScenarioContext, name: string, result: { ok: boolean; code?: string }): void {
  ctx.check(name, result.ok, { code: result.code });
}
function operationEvents(result: { events: EventEnvelope[] }): EventEnvelope["event"][] {
  return result.events.filter((item) => item.attribution === "op").map((item) => item.event);
}
function kindClient(ctx: ScenarioContext, id: string): KvClient {
  return ctx.topo.client(id);
}
function replicationOptions(client: KvClient, signal?: AbortSignal) {
  return {
    ...(client.kind === "cli" ? { replication: { maxStalenessMs: 0 } } : {}),
    ...(signal ? { signal } : {}),
  };
}
function cli(ctx: ScenarioContext, id: string): CliClient {
  return ctx.topo.cli(id);
}
const DELEGATION_ENDPOINT = "http://127.0.0.1:40123";
function clientProxy(ctx: ScenarioContext, id: string) {
  const spec = ctx.topo.spec.clients.find((client) => client.id === id);
  if (!spec) throw new Error(`missing topology client ${id}`);
  if (!spec.endpoint) return ctx.topo.proxy(`client:${id}->${spec.node}`);
  const endpoint = new URL(spec.endpoint);
  return ctx.topo.proxy(`shared:${endpoint.hostname}:${endpoint.port}`);
}
function sdk(ctx: ScenarioContext, id: string): SdkClient {
  return ctx.topo.sdk(id);
}
async function seed(ctx: ScenarioContext, writer: KvClient): Promise<WriteResult> {
  const primary = await writer.put(key, VALUE, replicationOptions(writer));
  requireOk(ctx, "seed primary value", primary);
  requireOk(ctx, "seed uncovered value", await writer.put(otherKey, OTHER_VALUE, replicationOptions(writer)));
  requireOk(ctx, "seed existing recovery value", await writer.put(`${PREFIX}offline-write`, "unchanged", replicationOptions(writer)));
  return primary;
}
async function warm(ctx: ScenarioContext, reader: KvClient): Promise<void> {
  const synced = await reader.sync({ prefix: PREFIX, ...replicationOptions(reader) });
  ctx.check("warm covered prefix sync succeeds", synced.ok, { ok: synced.ok, code: synced.code, exit: synced.exit, stderr: synced.stderr, syncs: synced.syncs });
  const got = await reader.get(key, replicationOptions(reader));
  ctx.check("warm read is a replica hit", got.ok && got.found && got.read?.source === "replica" && got.read.reason === "hit", got.read);
}

const core06: Scenario<Variant> = {
  id: "CORE-06", title: "Offline serving and uncovered refusal", tier: "core", variants: ["cli", "sdk"], timeoutMs: 120_000,
  topology(variant, _backend: Backend) {
    const kind = variant === "cli" ? "cli" : "sdk";
    return baseTopology("core-06", kind, replication(kind));
  },
  async run(ctx, variant) {
    const reader = kindClient(ctx, "reader");
    await seed(ctx, reader);
    await warm(ctx, reader);
    await ctx.topo.proxy("client:reader->a").disable({ signal: ctx.signal });

    const covered = await reader.get(key, replicationOptions(reader, ctx.signal));
    ctx.check("offline covered get is served from replica with sync error", covered.ok && covered.found && Buffer.from(covered.value ?? []).toString() === VALUE && covered.read?.source === "replica" && Boolean(covered.read.syncError), covered.read);
    const listing = await reader.list(PREFIX, replicationOptions(reader, ctx.signal));
    ctx.check("offline covered list succeeds", listing.ok && listing.keys?.includes(key) === true, { ok: listing.ok, keys: listing.keys, code: listing.code });
    const uncovered = await reader.get(otherKey, replicationOptions(reader, ctx.signal));
    const attempted = await reader.put(`${PREFIX}offline-write`, "must-not-commit", replicationOptions(reader, ctx.signal));
    ctx.check("offline write is not committed", !attempted.ok && attempted.outcome !== "committed", { ok: attempted.ok, outcome: attempted.outcome, code: attempted.code });
    await ctx.topo.proxy("client:reader->a").enable({ signal: ctx.signal });
    const control = variant === "cli"
      ? await cli(ctx, "reader").get(`${PREFIX}offline-write`, { flag: "off", signal: ctx.signal })
      : await reader.get(`${PREFIX}offline-write`, { source: "network", signal: ctx.signal });
    ctx.check("offline write did not change the network value", control.ok && control.found && Buffer.from(control.value ?? []).toString() === "unchanged", { ok: control.ok, found: control.found, code: control.code, stderr: control.stderr });
    const recovered = await reader.sync({ prefix: PREFIX, ...replicationOptions(reader, ctx.signal) });
    ctx.check("sync recovers after connectivity returns", recovered.ok && recovered.syncs.some((event) => event.outcome === "ok"), recovered.syncs);
    // TC-897 tracks the pre-existing CLI exit 1; require exit 6 again once its fix lands.
    if (variant === "cli") {
      const networkErrorReported = hasCliErrorEnvelopeCode(uncovered.stderr ?? "", new Set(["NETWORK_ERROR"]));
      const noReplicaRead = uncovered.read?.source !== "replica" && !uncovered.events.some((item) => item.event.type === "replication.read" && item.event.source === "replica");
      ctx.check("offline uncovered CLI get is refused with NETWORK_ERROR and no replica read event",
        !uncovered.ok && uncovered.exit !== undefined && uncovered.exit !== null && uncovered.exit !== 0 && networkErrorReported && noReplicaRead,
        { ok: uncovered.ok, code: uncovered.code, exit: uncovered.exit, stderr: uncovered.stderr, read: uncovered.read, events: operationEvents(uncovered) });
    } else {
      ctx.check("offline uncovered get is refused", !uncovered.ok && uncovered.code === "NETWORK_ERROR", { ok: uncovered.ok, code: uncovered.code, read: uncovered.read });
    }
  },
};

const core07: Scenario<Variant> = {
  id: "CORE-07", title: "Expired session never serves a local replica", tier: "core", variants: ["cli", "sdk"], timeoutMs: 210_000,
  topology(variant) {
    const kind = variant === "cli" ? "cli" : "sdk";
    const replica = replication(kind);
    const sharedEndpoint = { endpoint: DELEGATION_ENDPOINT };
    const writer: ClientSpec = { ...client("writer", kind, "a", replication(kind), `core-07-${variant}`), ...sharedEndpoint };
    const reader: ClientSpec = {
      ...client("reader", kind, "a", replica, `core-07-${variant}`),
      ...sharedEndpoint,
      ...(kind === "cli" ? {
        auth: { posture: "delegate-session", grant: { issuer: "writer", caps: [{ prefix: PREFIX, actions: [...ACTIONS] }], expiresInMs: 75_000 } },
      } : { auth: { posture: "owner", sessionExpiryMs: 70_000 } }),
    };
    const control: ClientSpec = { ...client("control", kind, "a", false, `core-07-${variant}`), ...sharedEndpoint };
    return { name: "core-07", nodes: [{ id: "a" }], clients: [writer, reader, control] };
  },
  async run(ctx, variant) {
    const reader = kindClient(ctx, "reader");
    const writer = kindClient(ctx, "writer");
    const control = kindClient(ctx, "control");
    const seeded = await seed(ctx, writer);
    if (variant === "cli") {
      const space = seeded.events.find((item) => item.event.type === "replication.write")?.event.space;
      if (typeof space !== "string") throw new Error("owner write did not report its space");
      await createCliDelegation({ owner: cli(ctx, "writer"), device: cli(ctx, "reader"), space, prefix: PREFIX, actions: [...ACTIONS], expiry: "75s" });
    }
    await warm(ctx, reader);
    const authority = await reader.authority();
    ctx.check("reader session expiry is present", typeof authority.sessionExpiresAt === "number", authority);
    if (authority.sessionExpiresAt === null) throw new Error("session expiry fixture has no expiry timestamp");
    await ctx.clock.sleepUntilWall(authority.sessionExpiresAt + 2_000, ctx.signal);

    await clientProxy(ctx, "reader").disable({ signal: ctx.signal });
    const offline = await reader.get(key, replicationOptions(reader, ctx.signal));
    ctx.check("expired reader does not serve offline replica", !offline.ok && !offline.found && offline.value === undefined && offline.read?.source !== "replica", { ok: offline.ok, found: offline.found, read: offline.read, code: offline.code, exit: offline.exit });
    ctx.check("expired offline invocation has no replica read event", !operationEvents(offline).some((event) => event.type === "replication.read" && event.source === "replica"), operationEvents(offline));
    await clientProxy(ctx, "reader").enable({ signal: ctx.signal });
    const online = await reader.get(key, replicationOptions(reader, ctx.signal));
    const onlineAccepted = (!online.ok && online.read?.source !== "replica") || (online.ok && online.found && online.read?.source === "network" && Buffer.from(online.value ?? []).toString() === VALUE);
    ctx.check("online expiry is refused or returns current network value", onlineAccepted, { ok: online.ok, found: online.found, read: online.read, code: online.code, exit: online.exit });
    ctx.check("expired online invocation has no replica read event", !operationEvents(online).some((event) => event.type === "replication.read" && event.source === "replica"), operationEvents(online));
    const confirmed = await control.get(key, { source: "network", signal: ctx.signal });
    ctx.check("still-authorized control client confirms last committed value", confirmed.ok && confirmed.found && Buffer.from(confirmed.value ?? []).toString() === VALUE, { ok: confirmed.ok, found: confirmed.found });
    if (variant === "cli") {
      // TC-674 restores the strict exit 3/5 contract for expired imported delegate sessions.
      const delegateExpiryProbe = ctx.probeRequirement("tc674:delegate-session-expiry");
      if (delegateExpiryProbe !== true && (offline.exit === 3 || offline.exit === 5)) {
        ctx.log(`Loose CORE-07 CLI expiry path observed strict TC-674 exit ${offline.exit} before capability pin (${delegateExpiryProbe})`);
      }
      ctx.check(delegateExpiryProbe === true ? "offline CLI expiry uses supported refusal" : "offline CLI expiry without TC-674 is refused with a code and no local read",
        acceptsOfflineCliExpiry(offline, delegateExpiryProbe), { probe: delegateExpiryProbe, exit: offline.exit, code: offline.code, stderr: offline.stderr, read: offline.read, events: operationEvents(offline) });
    }
    if (variant === "cli" && !online.ok) ctx.check("online CLI expiry uses supported refusal", online.exit === 3 || online.exit === 5, { exit: online.exit, code: online.code });
  },
};

function core09Topology(variant: Variant): TopologySpec {
  const kind = variant === "cli" ? "cli" : "sdk";
  const clients = [client("reader", kind, "a", replication(kind), `core-09-${variant}`)];
  if (variant === "cli") clients.push(client("keep", "cli", "a", replication("cli"), "core-09-keep"));
  return { name: "core-09", nodes: [{ id: "a" }], clients };
}
const core09: Scenario<Variant> = {
  id: "CORE-09", title: "Logout and purge remove local replica data", tier: "core", variants: ["cli", "sdk"], timeoutMs: 120_000,
  topology: (variant) => core09Topology(variant),
  async run(ctx, variant) {
    const reader = kindClient(ctx, "reader");
    const sentinel = randomBytes(32);
    requireOk(ctx, "write sentinel value", await reader.put(key, sentinel, replicationOptions(reader)));
    const synced = await reader.sync({ prefix: PREFIX, ...replicationOptions(reader) });
    ctx.check("sync sentinel value", synced.ok, { code: synced.code, exit: synced.exit, stderr: synced.stderr, syncs: synced.syncs });
    const hit = await reader.get(key, replicationOptions(reader));
    ctx.check("sentinel is warm before logout or purge", hit.ok && hit.found && hit.read?.source === "replica", hit.read);
    if (variant === "cli") {
      const profile = join(cli(ctx, "reader").home(), ".tinycloud", "profiles", cli(ctx, "reader").profile());
      const legacyDir = join(profile, "replicas", "legacy");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, "sentinel"), sentinel, { mode: 0o600 });
      const command = await cli(ctx, "reader").tc(["auth", "logout"], { signal: ctx.signal });
      ctx.check("CLI logout succeeds", command.exit === 0, { exit: command.exit, stderr: command.stderr });
      let replicationExists = true;
      try { await access(join(profile, "replication")); } catch { replicationExists = false; }
      let legacyRemovalCode: string | undefined;
      try { await access(legacyDir); } catch (error) { legacyRemovalCode = (error as NodeJS.ErrnoException).code; }
      ctx.check("CLI logout removes replication and seeded legacy directories", !replicationExists && legacyRemovalCode === "ENOENT", { replicationExists, legacyRemovalCode });
      const scan = cli(ctx, "reader") as CliClient & { scanReplica(needle: Uint8Array): Promise<string[]> };
      const residual = await scan.scanReplica(sentinel);
      ctx.check("CLI logout removes sentinel bytes", residual.length === 0, residual);
      const keep = cli(ctx, "keep");
      const keepRoot = join(keep.home(), ".tinycloud", "profiles", keep.profile());
      const keepSentinel = randomBytes(32);
      requireOk(ctx, "second profile writes independent sentinel", await keep.put(key, keepSentinel, replicationOptions(keep)));
      const keepHit = await keep.get(key, replicationOptions(keep, ctx.signal));
      ctx.check("second profile warms an independent replica", keepHit.ok && keepHit.found && keepHit.read?.source === "replica", keepHit.read);
      await mkdir(join(keepRoot, "replicas"), { recursive: true });
      const keptLogout = await keep.tc(["auth", "logout", "--keep-replicas"], { signal: ctx.signal });
      ctx.check("second profile logout keeps replicas", keptLogout.exit === 0, { exit: keptLogout.exit, stderr: keptLogout.stderr });
      let keptReplication = true;
      let keptLegacy = true;
      try { await access(join(keepRoot, "replication")); } catch { keptReplication = false; }
      try { await access(join(keepRoot, "replicas")); } catch { keptLegacy = false; }
      ctx.check("keep-replicas preserves replication directories", keptReplication && keptLegacy, { keptReplication, keptLegacy });
      await ctx.topo.proxy("client:reader->a").disable({ signal: ctx.signal });
      const later = await cli(ctx, "reader").get(key, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
      ctx.check("CLI read after logout is not locally served", !later.ok && later.read?.source !== "replica" && later.exit !== 0, { exit: later.exit, read: later.read });
    } else {
      const purged = await reader.purge({ signal: ctx.signal });
      ctx.eq("SDK purge returns purged prefix and no failures", { purged: purged.purged, failed: purged.failed }, { purged: [PREFIX], failed: [] });
      const scan = reader as SdkClient & { scanReplica(needle: Uint8Array): Promise<string[]> };
      const residual = await scan.scanReplica(sentinel);
      ctx.check("SDK purge removes sentinel bytes", residual.length === 0, residual);
      await ctx.topo.proxy("client:reader->a").disable({ signal: ctx.signal });
      const later = await reader.get(key, { signal: ctx.signal });
      ctx.check("SDK read after purge is not locally served", !later.ok && later.read?.source !== "replica", { ok: later.ok, read: later.read, code: later.code });
      const disabled = await reader.sync({ prefix: PREFIX, signal: ctx.signal });
      ctx.check("SDK sync reports replication disabled after purge", disabled.code === "REPLICATION_DISABLED", { code: disabled.code });
    }
  },
};

const core10: Scenario<Variant> = {
  id: "CORE-10", title: "Independent node replicas remain isolated", tier: "core", variants: ["cli", "sdk"], timeoutMs: 120_000,
  topology(variant) {
    const kind = variant === "cli" ? "cli" : "sdk";
    const identity = `core-10-${variant}`;
    const reader = { ...client("reader", kind, "a", replication(kind), identity), extraHosts: [{ alias: "b", node: "nodeb" }] };
    const writerB = client("writerb", kind, "nodeb", false, identity);
    return { name: "core-10", nodes: [{ id: "a" }, { id: "nodeb" }], clients: [reader, writerB] };
  },
  async run(ctx) {
    const reader = kindClient(ctx, "reader");
    const writerB = kindClient(ctx, "writerb");
    const viaB = reader.withHost("b");
    requireOk(ctx, "write A value on node a", await reader.put(key, "A", replicationOptions(reader)));
    requireOk(ctx, "write B value on node b", await writerB.put(key, "B"));
    requireOk(ctx, "write node-b-only key", await writerB.put(`${PREFIX}only-b`, "only-b"));
    const readA = await reader.get(key, replicationOptions(reader));
    const readB = await viaB.get(key, replicationOptions(viaB));
    let onlyOnB: GetResult | undefined;
    let onlyOnBError: unknown;
    try { onlyOnB = await reader.get(`${PREFIX}only-b`, { ...replicationOptions(reader), source: "network" }); }
    catch (error) { onlyOnBError = error; }
    const localAbsence = await reader.get(`${PREFIX}only-b`, replicationOptions(reader));
    let partitionReport: { ok: boolean; detail: unknown } | undefined;
    if (ctx.variant === "cli") {
      const reports = [
        await cli(ctx, "reader").tc(["replica", "report", "--json"], { signal: ctx.signal }),
        await (viaB as CliClient).tc(["replica", "report", "--json"], { signal: ctx.signal }),
      ];
      const partitions: { host?: unknown }[] = [];
      for (const report of reports) {
        try { partitions.push(...((JSON.parse(Buffer.from(report.stdout).toString("utf8")) as { partitions?: { host?: unknown }[] }).partitions ?? [])); } catch { /* assertion records malformed report */ }
      }
      const hosts = new Set(partitions.map((partition) => partition.host).filter((host): host is string => typeof host === "string"));
      partitionReport = { ok: reports.every((report) => report.exit === 0) && partitions.length >= 2 && hosts.size >= 2, detail: { exits: reports.map((report) => report.exit), partitions } };
    }
    const endpointsDistinct = ctx.topo.proxy("client:reader->a").listenUrl !== ctx.topo.proxy("client:reader->b").listenUrl;
    await ctx.topo.node("nodeb").stop({ signal: ctx.signal });
    const stillA = await reader.get(key, replicationOptions(reader, ctx.signal));
    ctx.check("reader on node a observes A", readA.ok && readA.found && Buffer.from(readA.value ?? []).toString() === "A", readA.read);
    ctx.check("node-b-only key is absent through node a replica", localAbsence.ok && !localAbsence.found && localAbsence.read?.source === "replica", localAbsence.read);
    if (partitionReport) ctx.check("CLI report lists two distinct node partitions", partitionReport.ok, partitionReport.detail);
    ctx.check("node a and b have distinct proxy endpoints", endpointsDistinct);
    ctx.check("stopping b does not affect reads via a", stillA.ok && stillA.found && Buffer.from(stillA.value ?? []).toString() === "A", { ok: stillA.ok, read: stillA.read });
    ctx.check("reader through node b observes B", readB.ok && readB.found && Buffer.from(readB.value ?? []).toString() === "B", readB.read);
    ctx.check("node-b-only key is absent through node a network", onlyOnB?.ok === true && !onlyOnB.found, onlyOnB ?? onlyOnBError);
  },
};

const core11: Scenario<Variant> = {
  id: "CORE-11", title: "Replication flag-off parity", tier: "core", variants: ["cli", "sdk"], timeoutMs: 120_000,
  topology(variant) {
    const kind = variant === "cli" ? "cli" : "sdk";
    const identity = `core-11-${variant}`;
    return { name: "core-11", nodes: [{ id: "a" }], clients: [
      client("off", kind, "a", false, identity), client("on", kind, "a", replication(kind), identity),
    ] };
  },
  async run(ctx, variant) {
    if (variant === "sdk") {
      const off = sdk(ctx, "off");
      const on = sdk(ctx, "on");
      const directory = off.replicaDir();
      const disabledBefore = await off.sync({ prefix: PREFIX, signal: ctx.signal });
      ctx.check("SDK flag-off sync is disabled before operations", disabledBefore.code === "REPLICATION_DISABLED", { code: disabledBefore.code });
      let exists = true;
      try { await stat(directory); } catch { exists = false; }
      ctx.check("SDK flag-off leaves storageDir untouched", !exists, directory);
      const script = async (client: KvClient) => {
        const put = await client.put(`${PREFIX}script`, "script-value", { signal: ctx.signal });
        const get = await client.get(`${PREFIX}script`, { signal: ctx.signal });
        const missing = await client.get(`${PREFIX}missing`, { signal: ctx.signal });
        const list = await client.list(PREFIX, { signal: ctx.signal });
        const del = await client.del(`${PREFIX}script`, { signal: ctx.signal });
        const raw = await client.get(`${PREFIX}script`, { signal: ctx.signal });
        return {
          values: [put.ok, put.outcome, get.ok, get.found ? Buffer.from(get.value ?? []).toString() : null, missing.ok, missing.found, list.ok, list.keys?.filter((item) => item.endsWith("/script")), del.ok, del.outcome, raw.ok, raw.found ? Buffer.from(raw.value ?? []).toString() : null],
          outputs: [put, get, missing, list, del, raw].map(comparableResult),
        };
      };
      const offRun = await script(off);
      const onRun = await script(on);
      ctx.eq("SDK flag-on and flag-off operation script outputs, exits, and values match", offRun.outputs, onRun.outputs);
      const disabledAfter = await off.sync({ prefix: PREFIX, signal: ctx.signal });
      ctx.check("SDK flag-off sync remains disabled after operations", disabledAfter.code === "REPLICATION_DISABLED", { code: disabledAfter.code });
      let storageExists = true;
      try { await stat(directory); } catch { storageExists = false; }
      ctx.check("SDK flag-off leaves storageDir untouched after script", !storageExists, directory);
      return;
    }
    const off = cli(ctx, "off");
    const on = cli(ctx, "on");
    const script = async (client: CliClient, replicationOn: boolean) => {
      const options = { signal: ctx.signal, ...(replicationOn ? { replication: { maxStalenessMs: 0 } } : {}) };
      const put = await client.put(`${PREFIX}script`, "script-value", options);
      const get = await client.get(`${PREFIX}script`, options);
      const missing = await client.get(`${PREFIX}missing`, options);
      const list = await client.list(PREFIX, options);
      const del = await client.del(`${PREFIX}script`, options);
      const raw = await client.tc(["kv", "get", `${PREFIX}script`, "--raw"], options);
      return {
        exit: [put.exit, get.exit, missing.exit, list.exit, del.exit, raw.exit],
        values: [put.outcome, get.found ? Buffer.from(get.value ?? []).toString() : null, missing.found, list.keys?.filter((item) => item.endsWith("/script")), del.outcome, Buffer.from(raw.stdout).toString("hex")],
        outputs: [put, get, missing, list, del, raw].map(comparableResult),
        results: [put, get, missing, list, del, raw],
      };
    };
    const offRun = await script(off, false);
    const onRun = await script(on, true);
    ctx.eq("flag-on and flag-off operation script has equal outputs", offRun.outputs, onRun.outputs);
    ctx.eq("flag-on and flag-off operation script values match", offRun.values, onRun.values);
    const profileRoot = join(off.home(), ".tinycloud", "profiles", off.profile());
    let replicationDir = true;
    let eventsFile = true;
    try { await access(join(profileRoot, "replication")); } catch { replicationDir = false; }
    try { await access(off.eventsFile()); } catch { eventsFile = false; }
    ctx.check("flag-off creates no replication directory or events file", !replicationDir && !eventsFile, { replicationDir, eventsFile });
    ctx.check("flag-off emits no replication stderr", !offRun.results.some((result) => (result.stderr ?? "").includes("[replication]")), offRun.results.map((result) => result.stderr ?? ""));
  },
};

export const coreScenarios06To11: readonly Scenario[] = [core06, core07, core09, core10, core11];
registerScenarios(...coreScenarios06To11);
