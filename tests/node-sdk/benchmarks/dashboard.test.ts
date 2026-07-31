import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDashboardData,
  renderDashboard,
  type DashboardRun,
} from "./dashboard";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function run(runId: string, timestamp: string): DashboardRun {
  return {
    schemaVersion: 2,
    runId,
    timestamp,
    server: { url: "http://127.0.0.1:9000", revision: "server-revision" },
    client: { revision: "client-revision", platform: "darwin", arch: "arm64" },
    config: { iterations: 10, warmupIterations: 2, sequential: true, duckDb: false },
    records: 10,
    summaries: [
      {
        span: "sdk.kv.get",
        source: "manual",
        count: 10,
        okCount: 10,
        errorCount: 0,
        minMs: 1,
        meanMs: 2,
        p50Ms: 2,
        p95Ms: 3,
        p99Ms: 4,
        maxMs: 4,
      },
    ],
  };
}

describe("benchmark dashboard", () => {
  test("merges local summaries and baselines by run ID in timestamp order", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinycloud-bench-dashboard-"));
    temporaryDirectories.push(root);
    const results = join(root, "results");
    const baselines = join(root, "baselines");
    await mkdir(results);
    await mkdir(baselines);

    const older = run("older", "2026-01-01T00:00:00.000Z");
    const newer = run("newer", "2026-02-01T00:00:00.000Z");
    await writeFile(join(results, "newer.summary.json"), JSON.stringify(newer));
    await writeFile(join(results, "older.summary.json"), JSON.stringify(older));
    await writeFile(join(baselines, "current.json"), JSON.stringify(older));

    const data = await loadDashboardData(results, baselines);

    expect(data.runs.map((item) => item.runId)).toEqual(["older", "newer"]);
    expect(data.baselineRunIds).toEqual(["older"]);
  });

  test("renders a self-contained page and escapes embedded script boundaries", () => {
    const unsafe = run("</script><script>alert(1)</script>", "2026-01-01T00:00:00.000Z");
    const html = renderDashboard({
      generatedAt: "2026-01-01T00:00:01.000Z",
      runs: [unsafe],
      baselineRunIds: [unsafe.runId],
    });

    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("TinyCloud benchmark history");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).not.toContain("https://");
  });
});
