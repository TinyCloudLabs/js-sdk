import type { Scenario } from "../../contracts/scenario";
import { checkReplicaHit, checkWrite, digest, flagOn, oneNode, ownerClient, randomValue, replication, text } from "./shared";

const clients = [
  ownerClient("w", "cli", replication(["notes/"]), "core-02"),
  ownerClient("r", "sdk", replication(["notes/"], { maxStalenessMs: 0 }), "core-02"),
];

export const core02: Scenario<"cli>sdk"> = {
  id: "CORE-02",
  title: "CLI writes are served by the SDK replica",
  tier: "core",
  variants: ["cli>sdk"],
  timeoutMs: 120_000,
  topology: () => oneNode("core-02", clients),
  async run(ctx) {
    const writer = ctx.topo.cli("w");
    const reader = ctx.topo.sdk("r");
    const stringValue = new TextEncoder().encode("core-cli-to-sdk");
    const binaryValue = randomValue();
    const otherValue = new TextEncoder().encode("outside-covered-prefix");

    for (const [key, value] of [["notes/a.txt", stringValue], ["notes/bin", binaryValue]] as const) {
      const result = await writer.put(key, value, { signal: ctx.signal, ...flagOn(writer) });
      checkWrite(ctx, writer, result, `CLI put ${key}`, true);
    }
    ctx.check("CLI put other/x succeeded", (await writer.put("other/x", otherValue, { signal: ctx.signal, ...flagOn(writer) })).ok);

    const stringRead = await reader.get("notes/a.txt", { signal: ctx.signal, ...flagOn(reader) });
    ctx.check("SDK gets notes/a.txt", stringRead.ok && stringRead.found);
    ctx.eq("SDK notes/a.txt value", text(stringRead.value), text(stringValue));
    checkReplicaHit(ctx, reader, stringRead, "SDK notes/a.txt");

    const binaryRead = await reader.get("notes/bin", { signal: ctx.signal, ...flagOn(reader) });
    ctx.check("SDK gets notes/bin", binaryRead.ok && binaryRead.found);
    ctx.eq("SDK notes/bin BLAKE3", digest(binaryRead.value ?? new Uint8Array()), digest(binaryValue));
    checkReplicaHit(ctx, reader, binaryRead, "SDK notes/bin");

    const statuses = await reader.status({ signal: ctx.signal });
    const notes = statuses.find((entry) => entry.prefix === "notes/");
    ctx.check("SDK status includes notes/", Boolean(notes), statuses);
    ctx.eq("SDK notes state", notes?.state, "ready");
    ctx.eq("SDK notes coverage", (notes as { coverage?: string } | undefined)?.coverage, "complete");
    ctx.eq("SDK notes grant unconstrained", (notes?.grant as { unconstrained?: boolean } | null | undefined)?.unconstrained, true);
  },
};
