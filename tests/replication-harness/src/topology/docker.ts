import { HarnessError, type CallOptions } from "../contracts/common";
import type { Clock } from "../contracts/clock";

export interface DockerResult { code: number; stdout: string; stderr: string }
export class Docker {
  readonly executable: string;
  constructor(command: readonly string[] = process.env.DOCKER ? process.env.DOCKER.trim().split(/\s+/) : ["sudo", "-n", "docker"]) {
    if (!command.length || !command[0]) throw new HarnessError("DOCKER_FAILED", "DOCKER command is empty");
    this.executable = command[0];
    this.prefix = command.slice(1);
  }
  private readonly prefix: readonly string[];
  async run(args: readonly string[], options: CallOptions = {}): Promise<DockerResult> {
    const child = Bun.spawn([this.executable, ...this.prefix, ...args], { stdout: "pipe", stderr: "pipe", signal: options.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = options.deadlineMs === undefined ? undefined : new Promise<never>((_, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new HarnessError("DEADLINE_EXCEEDED", `docker ${args[0]} exceeded ${options.deadlineMs}ms`)); }, options.deadlineMs);
    });
    try {
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const [stdout, stderr, code] = await (deadline ? Promise.race([output, deadline]) : output);
      if (code !== 0) throw new HarnessError("DOCKER_FAILED", `docker ${args[0]} exited ${code}: ${stderr.trim()}`, { args, code, stdout, stderr });
      return { code, stdout, stderr };
    } catch (error) {
      if (options.signal?.aborted) throw new HarnessError("ABORTED", String(options.signal.reason ?? "aborted"));
      throw error;
    } finally { clearTimeout(timer); }
  }
  async tryRun(args: readonly string[], options: CallOptions = {}): Promise<DockerResult> {
    try { return await this.run(args, options); }
    catch (error) { if (error instanceof HarnessError && error.code === "DOCKER_FAILED") return { code: 1, stdout: "", stderr: error.message }; throw error; }
  }
  async healthy(options: CallOptions = {}): Promise<void> { await this.run(["info", "--format", "{{.ServerVersion}}"], options); }
}
export function labels(runId: string, topoId: string): string[] { return ["--label", `tc893.run=${runId}`, "--label", `tc893.topo=${topoId}`]; }
export function remainingMs(clock: Clock, deadlineAt: number): number {
  const remaining = deadlineAt - clock.now();
  if (remaining <= 0) throw new HarnessError("DEADLINE_EXCEEDED", "topology operation deadline exceeded");
  return remaining;
}
