import type { CliClient } from "../contracts/client";
import type { Backend } from "../contracts/common";
import type { Scenario, ScenarioContext } from "../contracts/scenario";
import type { ClientSpec, TopologySpec } from "../contracts/topology";
import { createCliDelegation } from "../clients/cli-client";
import { registerScenarios } from "../runner/registry";
import { hasCliErrorEnvelopeCode } from "./core-07-expiry";

const PREFIX = "notes/";
const KEY = "notes/a.txt";
const VALUE = "tc893-expired-delegate";
const ACTIONS = ["get", "list", "metadata", "sync"] as const;

function readerProxy(ctx: ScenarioContext) {
  const endpoint = ctx.topo.spec.clients.find((client) => client.id === "reader")?.endpoint;
  if (!endpoint) return ctx.topo.proxy("client:reader->a");
  const url = new URL(endpoint);
  return ctx.topo.proxy(`shared:${url.hostname}:${url.port}`);
}

const scenario: Scenario<"cli"> = {
  id: "EDGE-33",
  title: "Expired imported delegate session refuses before node access",
  tier: "edge",
  variants: ["cli"],
  requires: ["tc674:delegate-session-expiry"],
  timeoutMs: 210_000,
  topology(_variant, _backend: Backend): TopologySpec {
    const sharedEndpoint = { endpoint: "http://127.0.0.1:40123" };
    const writer: ClientSpec = {
      id: "writer", kind: "cli", node: "a", identity: "edge-33", auth: { posture: "owner" },
      replication: { prefixes: [PREFIX], maxStalenessMs: 0 }, ...sharedEndpoint,
    };
    const reader: ClientSpec = {
      id: "reader", kind: "cli", node: "a", identity: "edge-33",
      auth: { posture: "delegate-session", grant: { issuer: "writer", caps: [{ prefix: PREFIX, actions: [...ACTIONS] }], expiresInMs: 75_000 } },
      replication: { prefixes: [PREFIX], maxStalenessMs: 0 }, ...sharedEndpoint,
    };
    return { name: "edge-33", nodes: [{ id: "a" }], clients: [writer, reader] };
  },
  async run(ctx) {
    const writer: CliClient = ctx.topo.cli("writer");
    const reader: CliClient = ctx.topo.cli("reader");
    const seeded = await writer.put(KEY, VALUE, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("owner writes before issuing delegate grant", seeded.ok, { code: seeded.code });
    const space = seeded.events.find((item) => item.event.type === "replication.write")?.event.space;
    if (typeof space !== "string") throw new Error("owner write did not report its space");
    await createCliDelegation({ owner: writer, device: reader, space, prefix: PREFIX, actions: [...ACTIONS], expiry: "75s" });
    const warmed = await reader.sync({ prefix: PREFIX, replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("delegate warms covered prefix before grant expiry", warmed.ok, { code: warmed.code, syncs: warmed.syncs });
    const warmRead = await reader.get(KEY, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    ctx.check("delegate reads a local replica before expiry", warmRead.ok && warmRead.found && warmRead.read?.source === "replica", warmRead.read);
    const authority = await reader.authority();
    ctx.check("imported delegate session expiry is observable", typeof authority.sessionExpiresAt === "number", authority);
    if (authority.sessionExpiresAt === null) throw new Error("delegate session fixture has no expiry timestamp");
    await ctx.clock.sleepUntilWall(authority.sessionExpiresAt + 2_000, ctx.signal);

    const proxy = readerProxy(ctx);
    await proxy.disable({ signal: ctx.signal });
    const offline = await reader.get(KEY, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    const offlineAuthError = hasCliErrorEnvelopeCode(offline.stderr ?? "", new Set(["AUTH_REQUIRED"]));
    ctx.check("expired imported delegate refuses offline with AUTH_REQUIRED", !offline.ok && offline.exit === 3 && offlineAuthError && offline.read?.source !== "replica", { ok: offline.ok, exit: offline.exit, code: offline.code, stderr: offline.stderr, read: offline.read });
    ctx.check("expired offline delegate invocation emits no replica read", !offline.events.some((item) => item.attribution === "op" && item.event.type === "replication.read" && item.event.source === "replica"), offline.events);
    await proxy.enable({ signal: ctx.signal });
    const online = await reader.get(KEY, { replication: { maxStalenessMs: 0 }, signal: ctx.signal });
    const onlineAuthError = hasCliErrorEnvelopeCode(online.stderr ?? "", new Set(["AUTH_REQUIRED"]));
    ctx.check("expired imported delegate refuses online before node access", !online.ok && online.exit === 3 && onlineAuthError && online.read?.source !== "replica", { ok: online.ok, exit: online.exit, code: online.code, stderr: online.stderr, read: online.read });
  },
};

registerScenarios(scenario);
