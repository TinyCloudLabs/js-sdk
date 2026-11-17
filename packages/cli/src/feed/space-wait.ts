import { ExitCode, OPENKEY_SPACE_SETUP_RETRY_HINT } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** Pauses between attempts after a "Space not found": 30 s in all, then the command gives up with a clear message. */
export const FEED_SPACE_WAIT_DELAYS_MS: readonly number[] = [2_000, 3_000, 5_000, 8_000, 12_000];

/**
 * The node's answer for a space it has no row for yet: `404 Space not found`. A brand-new OpenKey account's space is hosted in
 * the background after approval, so the first storage call can get it (TC-1608). Any other failure, including a missing
 * database or table inside a hosted space, does not match.
 */
export function isSpaceNotHosted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /space not found/i.test(message);
}

export interface SpaceWaitDependencies {
  sleep?(ms: number): Promise<void>;
  /** One line to the operator; stderr by default. */
  write?(line: string): void;
  delaysMs?: readonly number[];
}

/**
 * Run `attempt`; while it fails with "Space not found", wait and run it again, up to the bounded backoff, then fail with
 * `SPACE_SETUP_PENDING`. Every other error is thrown at once, untouched. The attempt must be safe to repeat: `connectFeedAgent` is
 * (the same DID may retry, and nothing is written before the registry exists).
 */
export async function retryWhileSpaceNotHosted<T>(attempt: () => Promise<T>, deps: SpaceWaitDependencies = {}): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const write = deps.write ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const delays = deps.delaysMs ?? FEED_SPACE_WAIT_DELAYS_MS;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isSpaceNotHosted(error)) throw error;
      const delay = delays[retry];
      if (delay === undefined) {
        const seconds = Math.round(delays.reduce((total, ms) => total + ms, 0) / 1000);
        throw new CLIError(
          "SPACE_SETUP_PENDING",
          `Your TinyCloud space is still being set up (the node answered "Space not found" for ${seconds} seconds). Nothing was lost: run the same command again in a minute.`,
          ExitCode.ERROR,
          { hint: OPENKEY_SPACE_SETUP_RETRY_HINT },
        );
      }
      if (retry === 0) write("Your TinyCloud space is still being set up (OpenKey hosts it after the first approval); retrying for up to 30 seconds…");
      await sleep(delay);
    }
  }
}
