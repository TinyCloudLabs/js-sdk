import type { Scenario } from "../../contracts/scenario";
import { checkReplicaHit, checkWrite, digest, flagOn, oneNode, ownerClient, randomValue, replication, replicationBound, text } from "./shared";

const clients = [
  ownerClient("r", "cli", replication(["notes/"]), "core-01"),
  ownerClient("w", "sdk", replication(["notes/"], { mode: "foreground" }), "core-01"),
];

export const core01: Scenario<"sdk>cli"> = {
  id: "CORE-01",
  title: "SDK writes are served by the CLI replica",
  tier: "core",
  variants: ["sdk>cli"],
  timeoutMs: 120_000,
  topology: () => oneNode("core-01", clients),
  async run(ctx) {
    const writer = ctx.topo.sdk("w");
    const reader = ctx.topo.cli("r");
    const stringValue = new TextEncoder().encode("core-sdk-to-cli");
    const binaryValue = randomValue();
    const otherValue = new TextEncoder().encode("outside-covered-prefix");

    for (const [key, value] of [["notes/a.txt", stringValue], ["notes/bin", binaryValue]] as const) {
      const result = await writer.put(key, value, { signal: ctx.signal, ...flagOn(writer) });
      checkWrite(ctx, writer, result, `SDK put ${key}`, true);
    }
    ctx.check("SDK put other/x succeeded", (await writer.put("other/x", otherValue, { signal: ctx.signal, ...flagOn(writer) })).ok);

    const stringRead = await reader.get("notes/a.txt", { signal: ctx.signal, ...flagOn(reader), ...replicationBound(reader, 0) });
    ctx.check("CLI gets notes/a.txt", stringRead.ok && stringRead.found);
    ctx.eq("CLI notes/a.txt value", text(stringRead.value), text(stringValue));
    checkReplicaHit(ctx, reader, stringRead, "CLI notes/a.txt");

    const binaryRead = await reader.get("notes/bin", { signal: ctx.signal, ...flagOn(reader), ...replicationBound(reader, 0) });
    ctx.check("CLI gets notes/bin", binaryRead.ok && binaryRead.found);
    ctx.eq("CLI notes/bin BLAKE3", digest(binaryRead.value ?? new Uint8Array()), digest(binaryValue));
    checkReplicaHit(ctx, reader, binaryRead, "CLI notes/bin");

    const sourceList = await writer.list("notes/", { source: "network", signal: ctx.signal, ...flagOn(writer) });
    const replicaList = await reader.list("notes/", { signal: ctx.signal, ...flagOn(reader), ...replicationBound(reader, 0) });
    ctx.check("SDK network list succeeded", sourceList.ok, sourceList);
    ctx.check("CLI replica list succeeded", replicaList.ok, replicaList);
    ctx.eq("CLI replica list source", replicaList.read?.source, "replica");
    ctx.eq("SDK network list source", sourceList.read?.source, "network");
    const listsPresent = Array.isArray(sourceList.keys) && Array.isArray(replicaList.keys);
    ctx.check("SDK network and CLI replica keys are present", listsPresent, { sourceList, replicaList });
    if (listsPresent) ctx.eq("CLI replica list equals SDK network list", replicaList.keys, sourceList.keys);

    const outside = await reader.get("other/x", { signal: ctx.signal, flag: "on" });
    ctx.check("CLI reads uncovered other/x from network", outside.ok && outside.found);
    ctx.eq("uncovered read source", outside.read?.source, "network");
    ctx.eq("uncovered read reason", outside.read?.reason, "not_covered");
    ctx.eq("other/x value", text(outside.value), text(otherValue));
  },
};
