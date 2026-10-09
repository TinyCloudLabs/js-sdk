import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { outputJson } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

export function registerNodeCommand(program: Command): void {
  const node = program.command("node").description("Node health and info");

  node
    .command("health")
    .description("Check node health")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const start = Date.now();
        const response = await fetch(`${ctx.host}/healthz`);
        const latencyMs = Date.now() - start;

        outputJson({
          healthy: response.ok,
          host: ctx.host,
          latencyMs,
        });
      } catch (error) {
        if (error instanceof TypeError && (error as Error).message.includes("fetch")) {
          outputJson({ healthy: false, host: (await ProfileManager.resolveContext(cmd.optsWithGlobals())).host, error: "Connection refused" });
        } else {
          return handleError(error);
        }
      }
    });

  node
    .command("version")
    .description("Get node version")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const response = await fetch(`${ctx.host}/info`);
        if (!response.ok) {
          throw new CLIError("NODE_ERROR", `Node returned ${response.status}`, ExitCode.NODE_ERROR);
        }

        const data = await response.json() as Record<string, unknown>;
        outputJson({ ...data, host: ctx.host });
      } catch (error) {
        return handleError(error);
      }
    });

  node
    .command("status")
    .description("Combined health and version info")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const start = Date.now();

        // Fetch health and version in parallel
        const [healthRes, versionRes] = await Promise.allSettled([
          fetch(`${ctx.host}/healthz`),
          fetch(`${ctx.host}/info`),
        ]);

        const latencyMs = Date.now() - start;
        const healthy = healthRes.status === "fulfilled" && healthRes.value.ok;

        let versionData: Record<string, unknown> = {};
        if (versionRes.status === "fulfilled" && versionRes.value.ok) {
          versionData = await versionRes.value.json() as Record<string, unknown>;
        }

        outputJson({
          healthy,
          host: ctx.host,
          latencyMs,
          ...versionData,
        });
      } catch (error) {
        return handleError(error);
      }
    });
}
