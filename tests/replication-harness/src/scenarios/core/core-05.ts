import type { Scenario } from "../../contracts/scenario";
import type { ClientKind } from "../../contracts/common";
import { checkWrite, flagOn, listHasOmission, oneNode, ownerClient, replication, replicationBound, waitUntil } from "./shared";

export const core05: Scenario<"sdk>cli" | "cli>sdk"> = {
  id: "CORE-05",
  title: "Deletes propagate as authoritative replica tombstones",
  tier: "core",
  variants: ["sdk>cli", "cli>sdk"],
  timeoutMs: 150_000,
  topology(variant) {
    const [writerKind, readerKind] = variant.split(">") as [ClientKind, ClientKind];
    const readerReplication = readerKind === "sdk"
      ? replication(["notes/"], { mode: "background", maxStalenessMs: 60_000, syncIntervalMs: 2_000 })
      : replication(["notes/"], { maxStalenessMs: 60_000 });
    const identity = `core-05-${writerKind}-${readerKind}`;
    const writer = ownerClient("w", writerKind, replication(["notes/"], writerKind === "sdk" ? { mode: "foreground" } : {}), identity);
    const reader = ownerClient("r", readerKind, readerReplication, identity);
    const clients = writerKind === "sdk" ? [reader, writer] : [writer, reader];
    return oneNode(`core-05-${writerKind}-${readerKind}`, clients);
  },
  async run(ctx) {
    const writer = ctx.topo.client("w");
    const reader = ctx.topo.client("r");
    const writerOptions = { signal: ctx.signal, ...flagOn(writer) };
    const readerOptions = { signal: ctx.signal, ...flagOn(reader) };
    const seed = await writer.put("notes/b", new TextEncoder().encode("delete-propagation"), writerOptions);
    checkWrite(ctx, writer, seed, "seed notes/b", true);
    const initialSync = await reader.sync({ prefix: "notes/", ...readerOptions });
    ctx.check("reader sync succeeds before deletion", initialSync.ok, initialSync);
    const warmRead = await reader.get("notes/b", readerOptions);
    ctx.check("reader is warm with notes/b", warmRead.ok && warmRead.found, warmRead);

    const deletion = await writer.del("notes/b", writerOptions);
    checkWrite(ctx, writer, deletion, "delete notes/b", true);

    await waitUntil(ctx, reader, async () => {
      const result = await reader.get("notes/b", { ...readerOptions, ...replicationBound(reader, 3_000) });
      const events = result.events.filter((entry) => entry.clientId === reader.id && entry.opSeq === result.opSeq && entry.attribution === "op" && entry.event.type === "replication.read");
      const read = events.at(-1)?.event ?? result.read;
      if (read?.source !== "replica" || read.reason !== "deleted") return undefined;
      ctx.check("reader get after delete is not found", reader.kind === "cli" ? result.exit === 4 : result.ok && !result.found, result);
      return result;
    }, "reader observes deleted tombstone", 100);

    const replicaList = await reader.list("notes/", readerOptions);
    ctx.check("reader replica list succeeds", replicaList.ok, replicaList);
    ctx.eq("list after deletion comes from replica", replicaList.read?.source, "replica");
    ctx.check("replica list keys are present", replicaList.keys !== undefined, replicaList);
    ctx.check("list omits notes/b", listHasOmission(replicaList.keys, "notes/b"), replicaList.keys);

    await ctx.topo.proxy("client:r->a").disable({ signal: ctx.signal });
    const offline = await reader.get("notes/b", { ...readerOptions, ...replicationBound(reader, 0) });
    ctx.check("offline deleted key remains not found", !offline.found, offline);
    ctx.eq("offline tombstone source", offline.read?.source, "replica");
    ctx.eq("offline tombstone reason", offline.read?.reason, "deleted");
  },
};
