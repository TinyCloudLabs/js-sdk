import type { EventEnvelope } from "../../contracts/events";
import type { Scenario } from "../../contracts/scenario";
import { checkWrite, flagOn, oneNode, ownerClient, replication, waitUntil } from "./shared";

export const core03: Scenario<"cli" | "sdk"> = {
  id: "CORE-03",
  title: "Read-your-writes and correlated foreground sync",
  tier: "core",
  variants: ["cli", "sdk"],
  timeoutMs: 120_000,
  topology(variant) {
    const kind = variant;
    return oneNode(`core-03-${kind}`, [ownerClient("r", kind, replication(["notes/"], kind === "sdk" ? { mode: "foreground" } : {}), `core-03-${kind}`)]);
  },
  async run(ctx) {
    const sequenceEvents: EventEnvelope[] = [];
    const client = ctx.topo.client("r");
    const options = { signal: ctx.signal, ...flagOn(client) };
    for (let index = 1; index <= 5; index++) {
      const value = new TextEncoder().encode(`v${index}`);
      const put = await client.put("notes/k", value, options);
      const get = await client.get("notes/k", options);
      sequenceEvents.push(...put.events, ...get.events);
      ctx.check(`get v${index} succeeded`, get.ok && get.found, get);
      ctx.eq(`get returns latest v${index}`, get.value, value);
    }

    const deletedValue = new TextEncoder().encode("v5");
    const deletion = await client.del("notes/k", options);
    const missing = await client.get("notes/k", options);
    sequenceEvents.push(...deletion.events, ...missing.events);
    if (client.kind === "cli") ctx.eq("CLI missing key exit code", missing.exit, 4);
    ctx.check("deleted key is not found", !missing.found, missing);
    ctx.check("deleted key does not return prior bytes", !missing.value || Buffer.compare(missing.value, deletedValue) !== 0, missing);

    const finalPut = await client.put("notes/k", new TextEncoder().encode("v7"), options);
    const finalSync = await client.sync({ prefix: "notes/", ...options });
    sequenceEvents.push(...finalPut.events, ...finalSync.events);
    checkWrite(ctx, client, finalPut, "final put v7", true);
    ctx.check("correlated sync succeeded", finalSync.ok, finalSync);
    const syncEvents = finalSync.events.filter((entry) => entry.clientId === client.id && entry.opSeq === finalSync.opSeq && entry.attribution === "op" && entry.event.type === "replication.sync");
    ctx.check("sync has attributed replication.sync", syncEvents.length > 0, finalSync.events);
    ctx.check("sync outcome ok and clears pending write", syncEvents.some((entry) => entry.event.outcome === "ok" && Number(entry.event.pendingCleared) >= 1), syncEvents);

    await waitUntil(ctx, client, async () => {
      const statuses = await client.status({ signal: ctx.signal });
      const notes = statuses.find((entry) => entry.prefix === "notes/");
      if (!notes) return undefined;
      return Number(notes.pending?.committed) === 0 && Number(notes.pending?.inFlight) === 0 && (!Array.isArray(notes.pinned) || notes.pinned.length === 0) ? notes : undefined;
    }, "notes pending committed and inFlight records cleared");
    const cleared = (await client.status({ signal: ctx.signal })).find((entry) => entry.prefix === "notes/");
    ctx.check("notes status exists after clearing", Boolean(cleared), cleared);
    ctx.check("notes pending counters are zero and no keys are pinned", cleared?.pending?.committed === 0 && cleared.pending.inFlight === 0 && (!Array.isArray(cleared.pinned) || cleared.pinned.length === 0), cleared);
    const finalRead = await client.get("notes/k", options);
    ctx.check("final v7 read succeeds", finalRead.ok && finalRead.found, finalRead);
    ctx.eq("final read returns v7", finalRead.value, new TextEncoder().encode("v7"));
    const finalReadEvents = finalRead.events.filter((entry) => entry.clientId === client.id && entry.opSeq === finalRead.opSeq && entry.attribution === "op" && entry.event.type === "replication.read");
    ctx.eq("final v7 read source", finalReadEvents.at(-1)?.event.source ?? finalRead.read?.source, "replica");
    ctx.eq("final v7 read reason", finalReadEvents.at(-1)?.event.reason ?? finalRead.read?.reason, "hit");
    sequenceEvents.push(...finalRead.events);
    const badSyncs = sequenceEvents.filter((entry) => entry.attribution === "op" && entry.event.type === "replication.sync" && (entry.event.outcome === "error" || entry.event.outcome === "busy"));
    ctx.eq("no attributed sync errors or busy events", badSyncs.length, 0);
  },
};
