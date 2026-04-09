import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { fileURLToPath } from "node:url";

export type ClusterNodeRole = "authority" | "host" | "replica";

export interface ClusterNodeConfig {
  name: string;
  role: ClusterNodeRole;
  port: number;
  env?: Record<string, string>;
}

export interface RunningNode {
  name: string;
  role: ClusterNodeRole;
  port: number;
  url: string;
  rootDir: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  env: Record<string, string>;
  process: ChildProcessWithoutNullStreams;
}

export interface ClusterOptions {
  nodeRepo?: string;
  nodeBin?: string;
  cargoTargetDir?: string;
  rootDir?: string;
  startupTimeoutMs?: number;
  healthPollMs?: number;
  nodes?: ClusterNodeConfig[];
  env?: Record<string, string>;
}

export interface RunningCluster {
  rootDir: string;
  nodeBin: string;
  nodes: RunningNode[];
  stopNode(nodeName: string): Promise<RunningNode>;
  startNode(nodeName: string): Promise<RunningNode>;
  stop(): Promise<void>;
  restartNode(nodeName: string): Promise<RunningNode>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const DEFAULT_PROMETHEUS_PORT_OFFSET = 100;
const DEFAULT_CARGO_BUILD_JOBS = "8";
const DEFAULT_NODE_PORT_START = 8010;
const DEFAULT_PROMETHEUS_PORT_START = 8510;
const PORT_RANGE_START = 8000;
const PORT_RANGE_END = 8999;

const DEFAULT_NODES: ClusterNodeConfig[] = [
  { name: "node-a", role: "authority", port: 8010 },
  { name: "node-b", role: "host", port: 8011 },
  { name: "node-c", role: "replica", port: 8012 },
];

interface AssignedClusterNodeConfig extends ClusterNodeConfig {
  prometheusPort: number;
}

function replicationRoleEnv(role: ClusterNodeRole): "host" | "replica" {
  return role === "replica" ? "replica" : "host";
}

function repoRootFromThisFile(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function bootstrapTinycloudRepoCandidate(): string {
  return resolve(
    repoRootFromThisFile(),
    "../../../tinycloud-node/feat/replication-e2e-bootstrap"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(
  preferredPort: number,
  usedPorts: Set<number>,
  start = PORT_RANGE_START,
  end = PORT_RANGE_END
): Promise<number> {
  for (let offset = 0; offset <= end - start; offset += 1) {
    const candidate =
      start + ((preferredPort - start + offset + (end - start + 1)) % (end - start + 1));
    if (usedPorts.has(candidate)) {
      continue;
    }
    if (await isPortAvailable(candidate)) {
      usedPorts.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Could not find a free port in ${start}-${end}`);
}

async function assignClusterPorts(
  configs: ClusterNodeConfig[]
): Promise<AssignedClusterNodeConfig[]> {
  const usedPorts = new Set<number>();
  const assigned: AssignedClusterNodeConfig[] = [];

  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const port = await findAvailablePort(
      config.port ?? DEFAULT_NODE_PORT_START + index,
      usedPorts
    );
    const prometheusPort = await findAvailablePort(
      DEFAULT_PROMETHEUS_PORT_START + index * DEFAULT_PROMETHEUS_PORT_OFFSET,
      usedPorts
    );
    assigned.push({
      ...config,
      port,
      prometheusPort,
    });
  }

  return assigned;
}

async function resolveNodeRepo(options: ClusterOptions): Promise<string> {
  if (options.nodeRepo) {
    return resolve(options.nodeRepo);
  }

  if (process.env.TC_REPLICATION_NODE_REPO) {
    return resolve(process.env.TC_REPLICATION_NODE_REPO);
  }

  const candidate = bootstrapTinycloudRepoCandidate();
  if (await pathExists(candidate)) {
    return candidate;
  }

  throw new Error(
    "Could not resolve tinycloud-node repo path. Set TC_REPLICATION_NODE_REPO or pass nodeRepo explicitly."
  );
}

async function resolveNodeBinary(options: ClusterOptions): Promise<string> {
  if (options.nodeBin) {
    return resolve(options.nodeBin);
  }

  if (process.env.TC_REPLICATION_NODE_BIN) {
    return resolve(process.env.TC_REPLICATION_NODE_BIN);
  }

  const nodeRepo = await resolveNodeRepo(options);
  const cargoTargetDir = resolve(
    options.cargoTargetDir ??
      process.env.TC_REPLICATION_CARGO_TARGET_DIR ??
      join(nodeRepo, ".replication-target")
  );
  const binaryPath = join(cargoTargetDir, "debug", "tinycloud");

  if (!(await pathExists(binaryPath))) {
    const build = spawnSync("cargo", ["build", "-j", DEFAULT_CARGO_BUILD_JOBS, "--bin", "tinycloud"], {
      cwd: nodeRepo,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: cargoTargetDir,
        CARGO_INCREMENTAL: "0",
        CARGO_PROFILE_DEV_DEBUG: "0",
        OPENSSL_NO_VENDOR: "1",
      },
      stdio: "inherit",
    });

    if (build.status !== 0) {
      throw new Error(
        `Failed to build tinycloud binary in ${nodeRepo} using target dir ${cargoTargetDir}`
      );
    }
  }

  if (!(await pathExists(binaryPath))) {
    throw new Error(`tinycloud binary not found at ${binaryPath}`);
  }

  return binaryPath;
}

function base64UrlSecret(seedByte: number): string {
  return Buffer.alloc(32, seedByte).toString("base64url");
}

async function waitForHealthy(
  url: string,
  timeoutMs: number,
  pollMs: number
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      const info = await fetch(`${url}/info`, {
        signal: AbortSignal.timeout(2_000),
      });

      if (health.ok && info.ok) {
        return;
      }

      lastError = new Error(
        `health=${health.status} info=${info.status} while waiting for ${url}`
      );
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(pollMs);
  }

  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");

  const exited = Promise.race([
    once(child, "exit"),
    Bun.sleep(timeoutMs).then(() => null),
  ]);

  const result = await exited;
  if (result === null && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function readLogTail(path: string, maxChars = 4_000): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.slice(-maxChars);
  } catch {
    return null;
  }
}

async function startNode(
  nodeBin: string,
  clusterRootDir: string,
  config: AssignedClusterNodeConfig,
  inheritedEnv: Record<string, string>
): Promise<RunningNode> {
  const nodeRootDir = join(clusterRootDir, config.name);
  const dataDir = join(nodeRootDir, "data");
  const blocksDir = join(nodeRootDir, "blocks");
  const logsDir = join(nodeRootDir, "logs");
  const stdoutLogPath = join(logsDir, "stdout.log");
  const stderrLogPath = join(logsDir, "stderr.log");

  await mkdir(dataDir, { recursive: true });
  await mkdir(blocksDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const env: Record<string, string> = {
    ...process.env,
    ...inheritedEnv,
    ...config.env,
    ROCKET_ADDRESS: "127.0.0.1",
    ROCKET_PORT: String(config.port),
    TINYCLOUD_PROMETHEUS_PORT: String(config.prometheusPort),
    TINYCLOUD_STORAGE_BLOCKS_TYPE: "Local",
    TINYCLOUD_STORAGE_BLOCKS_PATH: blocksDir,
    TINYCLOUD_STORAGE_DATADIR: dataDir,
    TINYCLOUD_STORAGE_DATABASE: `sqlite:${join(dataDir, "caps.db")}`,
    TINYCLOUD_KEYS_TYPE: "Static",
    TINYCLOUD_REPLICATION_ROLE:
      config.env?.TINYCLOUD_REPLICATION_ROLE ?? replicationRoleEnv(config.role),
    ...(config.role === "replica" &&
    config.env?.TINYCLOUD_REPLICATION_PEER_SERVING === undefined
      ? { TINYCLOUD_REPLICATION_PEER_SERVING: "false" }
      : {}),
    TINYCLOUD_KEYS_SECRET:
      config.env?.TINYCLOUD_KEYS_SECRET ??
      base64UrlSecret(config.port - DEFAULT_NODES[0].port + 1),
  };

  const child = spawn(nodeBin, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(createWriteStream(stdoutLogPath, { flags: "a" }));
  child.stderr.pipe(createWriteStream(stderrLogPath, { flags: "a" }));

  const node: RunningNode = {
    name: config.name,
    role: config.role,
    port: config.port,
    url: `http://127.0.0.1:${config.port}`,
    rootDir: nodeRootDir,
    stdoutLogPath,
    stderrLogPath,
    env,
    process: child,
  };

  const startupTimeoutMs = Number(
    env.TC_REPLICATION_STARTUP_TIMEOUT_MS ?? DEFAULT_STARTUP_TIMEOUT_MS
  );
  const healthPollMs = Number(env.TC_REPLICATION_HEALTH_POLL_MS ?? DEFAULT_HEALTH_POLL_MS);

  const startupResult = await Promise.race([
    waitForHealthy(node.url, startupTimeoutMs, healthPollMs).then(() => ({
      kind: "ready" as const,
    })),
    once(child, "exit").then(async ([code, signal]) => ({
      kind: "exit" as const,
      code,
      signal,
      stderrTail: await readLogTail(stderrLogPath),
    })),
  ]);

  if (startupResult.kind === "exit") {
    const stderrSection = startupResult.stderrTail
      ? `\n--- stderr tail ---\n${startupResult.stderrTail}`
      : "";
    throw new Error(
      `Node ${config.name} exited before becoming healthy at ${node.url} (code=${startupResult.code}, signal=${startupResult.signal ?? "none"}). Logs: ${stderrLogPath}${stderrSection}`
    );
  }

  if (child.exitCode !== null || child.killed) {
    const stderrTail = await readLogTail(stderrLogPath);
    const stderrSection = stderrTail ? `\n--- stderr tail ---\n${stderrTail}` : "";
    throw new Error(
      `Node ${config.name} stopped before startup completed at ${node.url}. Logs: ${stderrLogPath}${stderrSection}`
    );
  }

  return node;
}

export async function startCluster(
  options: ClusterOptions = {}
): Promise<RunningCluster> {
  const clusterTmpRoot =
    process.env.TC_REPLICATION_TMPDIR ?? process.env.TMPDIR ?? tmpdir();
  const rootDir =
    options.rootDir ??
    (await mkdtemp(join(clusterTmpRoot, "tinycloud-replication-cluster-")));
  const nodeBin = await resolveNodeBinary(options);
  const nodes: RunningNode[] = [];
  const stopNodeByName = async (nodeName: string): Promise<RunningNode> => {
    const node = nodes.find((candidate) => candidate.name === nodeName);
    if (!node) {
      throw new Error(`Unknown cluster node: ${nodeName}`);
    }

    await stopProcess(node.process);
    return node;
  };
  const startNodeByName = async (nodeName: string): Promise<RunningNode> => {
    const node = nodes.find((candidate) => candidate.name === nodeName);
    if (!node) {
      throw new Error(`Unknown cluster node: ${nodeName}`);
    }

    if (node.process.exitCode === null && !node.process.killed) {
      return node;
    }

    const prometheusPort = Number(node.env.TINYCLOUD_PROMETHEUS_PORT);
    if (!Number.isFinite(prometheusPort)) {
      throw new Error(
        `Cluster node ${nodeName} is missing a valid TINYCLOUD_PROMETHEUS_PORT`
      );
    }

    const started = await startNode(nodeBin, rootDir, {
      name: node.name,
      role: node.role,
      port: node.port,
      prometheusPort,
      env: {
        TINYCLOUD_KEYS_SECRET: node.env.TINYCLOUD_KEYS_SECRET,
      },
    }, node.env);

    node.process = started.process;
    node.env = started.env;
    return node;
  };

  try {
    const configs = await assignClusterPorts(options.nodes ?? DEFAULT_NODES);
    for (const config of configs) {
      const node = await startNode(nodeBin, rootDir, config, options.env ?? {});
      nodes.push(node);
    }
  } catch (error) {
    await Promise.all(nodes.map((node) => stopProcess(node.process)));
    throw new Error(
      `Cluster startup failed. Preserved logs and data at ${rootDir}. ${String(error)}`
    );
  }

  return {
    rootDir,
    nodeBin,
    nodes,
    async stopNode(nodeName: string) {
      return await stopNodeByName(nodeName);
    },
    async startNode(nodeName: string) {
      return await startNodeByName(nodeName);
    },
    async stop() {
      await Promise.all(nodes.map((node) => stopProcess(node.process)));
      await rm(rootDir, { recursive: true, force: true });
    },
    async restartNode(nodeName: string) {
      await stopNodeByName(nodeName);
      return await startNodeByName(nodeName);
    },
  };
}
