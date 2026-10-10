import type { Scenario } from "../../contracts/scenario";
import type { ClientKind } from "../../contracts/common";
import { waitFor } from "../../contracts/clock";
import { checkWrite, flagOn, oneNode, ownerClient, replication, replicationBound, text } from "./shared";


export const core04: Scenario<"sdk>cli" | "cli>sdk"> = {
  id: "CORE-04",
  title: "Remote changes become visible within bounded staleness",
  tier: "core",
  variants: ["sdk>cli", "cli>sdk"],
  timeoutMs: 150_000,
  topology(variant) {
    const [writerKind, readerKind] = variant.split(">") as [ClientKind, ClientKind];
    const readerReplication = readerKind === "sdk"
      ? replication(["notes/"], { mode: "background", maxStalenessMs: 3_000, syncIntervalMs: 2_000 })
      : replication(["notes/"], { maxStalenessMs: 60_000 });
    const identity = `core-04-${writerKind}-${readerKind}`;
    const writer = ownerClient("w", writerKind, replication(["notes/"], writerKind === "sdk" ? { mode: "foreground" } : {}), identity);
    const reader = ownerClient("r", readerKind, readerReplication, identity);
    const clients = writerKind === "sdk" ? [reader, writer] : [writer, reader];
    return oneNode(`core-04-${writerKind}-${readerKind}`, clients);
  },
  async run(ctx, variant) {
    const writerKind = variant.split(">")[0] as ClientKind;
    const writer = ctx.topo.client("w");
    const reader = ctx.topo.client("r");
    const callOptions = { signal: ctx.signal };
    const v1 = new TextEncoder().encode("v1");
    const v2 = new TextEncoder().encode("v2");

    const initialWrite = await writer.put("notes/b", v1, { ...callOptions, ...flagOn(writer) });
    checkWrite(ctx, writer, initialWrite, "write v1", true);
    const warm = await reader.sync({ prefix: "notes/", ...callOptions, ...flagOn(reader) });
    ctx.check("reader syncs initial v1", warm.ok, warm);
    const warmedRead = await reader.get("notes/b", { ...callOptions, ...flagOn(reader) });
    ctx.check("reader is warm at v1", warmedRead.ok && warmedRead.found, warmedRead);
    ctx.eq("warm read value", text(warmedRead.value), "v1");
    ctx.eq("warm read source", warmedRead.read?.source, "replica");

    const update = await writer.put("notes/b", v2, { ...callOptions, ...flagOn(writer) });
    const writeAt = ctx.clock.now();
    checkWrite(ctx, writer, update, "write v2", true);

    const defaultRead = await reader.get("notes/b", { ...callOptions, ...flagOn(reader), ...replicationBound(reader, 60_000) });
    ctx.check("immediate bounded read succeeds", defaultRead.ok && defaultRead.found, defaultRead);
    const immediateValue = text(defaultRead.value);
    ctx.check("immediate read returns v1 or v2", immediateValue === "v1" || immediateValue === "v2", defaultRead);
    if (immediateValue === "v1") {
      ctx.eq("immediate v1 is from replica", defaultRead.read?.source, "replica");
      ctx.check("immediate v1 is within 60s staleness bound", Number.isFinite(defaultRead.read?.stalenessMs) && Number(defaultRead.read?.stalenessMs) <= 60_000, defaultRead.read);
    } else if (defaultRead.read?.source === "network") {
      ctx.eq("network read returns v2", immediateValue, "v2");
    }

    let sawV2 = immediateValue === "v2";
    let visibleAt: number | undefined = sawV2 ? ctx.clock.now() : undefined;
    if (!sawV2) {
      await waitFor(ctx.clock, async () => {
        const result = await reader.get("notes/b", { ...callOptions, ...flagOn(reader), ...replicationBound(reader, 3_000) });
        ctx.check("bounded polling read succeeds", result.ok && result.found, result);
        const value = text(result.value);
        if (value === "v1") {
          ctx.eq("poll v1 is from replica", result.read?.source, "replica");
          ctx.check("poll v1 respects 3s staleness bound", Number.isFinite(result.read?.stalenessMs) && Number(result.read?.stalenessMs) <= 3_000, result.read);
          return undefined;
        }
        ctx.eq("poll returns v2", value, "v2");
        sawV2 = true;
        visibleAt = ctx.clock.now();
        return result;
      }, { deadlineMs: Math.max(0, ctx.deadline(reader) - (ctx.clock.now() - writeAt)), describe: "reader observes v2 within its deadline", intervalMs: 100, signal: ctx.signal });
    }
    ctx.check("reader observed v2", sawV2);
    const afterVisibility = await reader.get("notes/b", { ...callOptions, ...flagOn(reader), ...replicationBound(reader, 3_000) });
    ctx.check("post-visibility read succeeds", afterVisibility.ok && afterVisibility.found, afterVisibility);
    ctx.eq("reader never regresses after v2", text(afterVisibility.value), "v2");
    if (visibleAt !== undefined) ctx.metric("writeToVisibleMs", visibleAt - writeAt, "ms");
    ctx.log(`CORE-04 ${writerKind}→${variant.split(">")[1]} observed v2`);
  },
};
