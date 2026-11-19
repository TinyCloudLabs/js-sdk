import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** A throwaway tinycloud node on a free 127.0.0.1 port, with its own data directory. */
export interface LocalNode {
  readonly host: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return listening.reject(new Error("No local node port"));
    server.close(() => listening.resolve(address.port));
  });
  return listening.promise;
}

/** Start `binary` (e.g. `TC_REPLICATION_E2E_NODE_BIN`) and resolve once it serves. */
export async function startLocalNode(binary: string, directoryPrefix: string): Promise<LocalNode> {
  const directory = await mkdtemp(directoryPrefix);
  const port = await freePort();
  const child: ChildProcess = spawn(binary, [], {
    cwd: directory,
    env: {
      ...process.env,
      TINYCLOUD_STORAGE__DATADIR: join(directory, "data"),
      TINYCLOUD_PORT: String(port),
      TINYCLOUD_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
      ROCKET_ADDRESS: "127.0.0.1",
      TINYCLOUD_KEYS__TYPE: "Static",
      TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      await exited.promise;
    }
    await rm(directory, { recursive: true, force: true });
  };
  const launched = Promise.withResolvers<void>();
  const timer = setTimeout(() => launched.reject(new Error("Real node did not become ready")), 45_000);
  let output = "";
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("Rocket has launched")) launched.resolve();
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.once("error", launched.reject);
  child.once("exit", (code) => launched.reject(new Error(`Real node exited before readiness (${code})`)));
  try {
    await launched.promise;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { host: `http://127.0.0.1:${port}`, stop };
}
