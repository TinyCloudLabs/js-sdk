import { spawn } from "node:child_process";
import type { FeedResponse } from "@tinycloud/sdk-services/feed";

/** Exit zero must mean this runner durably accepted the response ID. */
export function runFeedRunner(
  argv: readonly [string, ...string[]], response: FeedResponse, signal?: AbortSignal,
): Promise<"delivered" | "unconfirmed"> {
  if (signal?.aborted) return Promise.resolve("unconfirmed");
  // Executor form supports the CLI's Node 20 floor (no Promise.withResolvers).
  return new Promise((resolve) => {
    let settled = false;
    let interrupted = false;
    let failed = false;
    let stop: (() => void) | undefined;
    const finish = (state: "delivered" | "unconfirmed") => {
      if (settled) return;
      settled = true;
      if (stop) signal?.removeEventListener("abort", stop);
      resolve(state);
    };
    try {
      const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ["pipe", "inherit", "inherit"] });
      child.once("error", () => { failed = true; finish("unconfirmed"); });
      child.stdin.on("error", () => { failed = true; });
      child.once("close", (code, exitSignal) =>
        finish(!interrupted && !failed && code === 0 && exitSignal === null ? "delivered" : "unconfirmed"));
      stop = () => {
        interrupted = true;
        // Explicit cancellation must not wait indefinitely for a cooperative runner.
        // Its action may already have happened; the handoff remains unconfirmed.
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      else child.stdin.end(`${JSON.stringify(response)}\n`);
    } catch {
      finish("unconfirmed");
    }
  });
}
