import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "../../contracts/scenario";
import { oneNode, ownerClient, replication } from "./shared";
const clients = [
  ownerClient("cli", "cli", replication(), "core-00"),
  ownerClient("sdk", "sdk", replication(["notes/"]), "core-00"),
];

export const core00: Scenario = {
  id: "CORE-00",
  title: "Replication preflight",
  tier: "core",
  timeoutMs: 60_000,
  topology: () => oneNode("core-00", clients),
  async run(ctx) {
    const node = ctx.topo.node("a");
    const health = await fetch(`${node.diagnosticsUrl}/healthz`, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]) });
    ctx.eq("node a healthz status", health.status, 200);

    const info = await node.info({ signal: ctx.signal, deadlineMs: 10_000 });
    ctx.check("node a advertises kv-sync-v1", info.features.includes("kv-sync-v1"), info.features);
    ctx.eq("node version matches image", info.version, node.image.nodeVersion);

    const cli = ctx.topo.cli("cli");
    const version = await cli.tc(["--version"], { signal: ctx.signal, deadlineMs: 10_000 });
    ctx.check("CLI version invocation succeeds", version.exit === 0, version);
    const cliVersionOutput = new TextDecoder().decode(version.stdout).trim();
    let cliVersion: unknown = cliVersionOutput;
    try {
      const parsed: unknown = JSON.parse(cliVersionOutput);
      if (typeof parsed === "string") cliVersion = parsed;
      else if (parsed && typeof parsed === "object" && "version" in parsed) cliVersion = parsed.version;
    } catch { /* the CLI may print a plain semver string */ }
    ctx.eq("CLI version matches SUT", cliVersion, ctx.env.sut.cli.version);
    const help = await cli.tc(["--help"], { signal: ctx.signal, deadlineMs: 10_000 });
    ctx.check("CLI help invocation succeeds", help.exit === 0, help);
    ctx.check("CLI help exposes --replication", new TextDecoder().decode(help.stdout).includes("--replication"), new TextDecoder().decode(help.stdout));

    const hello = await ctx.topo.sdk("sdk").rpc("hello", {});
    ctx.check("node-sdk exports TinyCloudNode", hello.exports.includes("TinyCloudNode"), hello.exports);
    ctx.check("node-sdk exports sqliteReplicaStorage", hello.exports.includes("sqliteReplicaStorage"), hello.exports);
    const nodeVersionProcess = Bun.spawn([process.env.HARNESS_NODE ?? "node", "--version"], {
      env: { PATH: process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
    });
    const [nodeVersionExit, nodeVersionOutput, nodeVersionError] = await Promise.all([
      nodeVersionProcess.exited,
      new Response(nodeVersionProcess.stdout).text(),
      new Response(nodeVersionProcess.stderr).text(),
    ]);
    const actualNodeVersion = nodeVersionOutput.trim();
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(actualNodeVersion);
    ctx.check("HARNESS_NODE --version succeeds", nodeVersionExit === 0, { exit: nodeVersionExit, error: nodeVersionError });
    ctx.check("HARNESS_NODE runtime is at least 22.13", Boolean(match) && (Number(match?.[1]) > 22 || (Number(match?.[1]) === 22 && Number(match?.[2]) >= 13)), actualNodeVersion);
    const root = ctx.env.sut.root;
    ctx.check("resolved SUT root is available for SDK preflight", typeof root === "string", ctx.env.sut);
    if (!root) return;
    const sdkLoader = ctx.env.sut.source === "published"
      ? join(root, "tc893-load-node-sdk.mjs")
      : join(root, "node_modules", ".tc893", "load-node-sdk.mjs");
    const replicaDir = join(ctx.env.resultsDir, ctx.env.runId, ctx.topo.id, "preflight-replica");
    await mkdir(replicaDir, { recursive: true, mode: 0o700 });
    const source = [
      'import { pathToFileURL } from "node:url";',
      'const { sdk } = await import(pathToFileURL(process.env.TC893_LOADER).href);',
      'const storage = sdk.sqliteReplicaStorage({ dir: process.env.TC893_REPLICA_DIR });',
      'const node = new sdk.TinyCloudNode({ host: "http://127.0.0.1:1", domain: "127.0.0.1", autoCreateSpace: false, autoBootstrapAccount: false, enablePublicSpace: false, replication: { enabled: true, storage, prefixes: ["notes/"], mode: "foreground" } });',
      'process.stdout.write(JSON.stringify({ hasReplication: "replication" in node }));',
    ].join("\n");
    const processResult = Bun.spawn([process.env.HARNESS_NODE ?? "node", "--input-type=module", "-e", source], {
      env: { PATH: process.env.PATH, TC893_LOADER: sdkLoader, TC893_REPLICA_DIR: replicaDir },
      stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
    });
    const [exit, output, error] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);
    ctx.check("SDK TinyCloudNode preflight process succeeds", exit === 0, { exit, error });
    const probe = JSON.parse(output) as { hasReplication: boolean };
    ctx.check("TinyCloudNode constructed with replication exposes node.replication", probe.hasReplication, probe);
  },
};
