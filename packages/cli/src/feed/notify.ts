import { randomBytes } from "node:crypto";
import { CLIError } from "../output/errors.js";
import {
  givesWebhookHeaders, readWebhookHeaders, registerWebhookChecked, webhookCallbackUrl, invalidInput,
  type WebhookHeaderReaders, type WebhookRegistrar,
} from "../lib/webhook-headers.js";

export interface FeedNotifyOptions {
  notifyUrl?: string;
  notifyHeader?: string[];
  notifyHeaderEnv?: string[];
  notifyHeaderFile?: string[];
  notifyHeaderStdin?: string[];
}

export interface FeedNotify {
  readonly callbackUrl: string;
  readonly headers: Record<string, string>;
}

const NAMES = {
  header: "--notify-header", env: "--notify-header-env", file: "--notify-header-file", stdin: "--notify-header-stdin",
} as const;

/** Header values come from a flag, the environment, a file or stdin and are never echoed in an error. */
export async function resolveFeedNotify(
  options: FeedNotifyOptions, readers?: WebhookHeaderReaders,
): Promise<FeedNotify | undefined> {
  const flags = {
    header: options.notifyHeader, headerEnv: options.notifyHeaderEnv,
    headerFile: options.notifyHeaderFile, headerStdin: options.notifyHeaderStdin,
  };
  if (options.notifyUrl === undefined) {
    if (givesWebhookHeaders(flags)) invalidInput("--notify-header, --notify-header-env, --notify-header-file and --notify-header-stdin need --notify-url");
    return undefined;
  }
  const callbackUrl = webhookCallbackUrl(options.notifyUrl, "--notify-url", "--notify-header");
  return { callbackUrl, headers: await readWebhookHeaders(flags, NAMES, readers) };
}

export interface FeedNotifyReceipt {
  readonly id: string;
  readonly callbackUrl: string;
  /** Header names only; the values are stored encrypted by the node and cannot be read back. */
  readonly headerNames: string[];
  /** HMAC secret for X-TinyCloud-Signature, shown once; the node does not return it. */
  readonly secret: string;
  /** Earlier webhooks for the same URL on this feed, removed because this one replaces them. */
  readonly replaced: string[];
  /** Earlier webhooks that could not be removed and still deliver; unregister them by id. */
  readonly staleRemaining?: number;
  /**
   * Set when the node's webhook cap forced remove-then-register: events written between the removal and the new
   * registration were not delivered. Run `next` once to pick them up.
   */
  readonly missedWhileReplacing?: true;
  readonly next?: string;
}

/** The node refuses a new subscription past its per-space cap with 429. */
function isCapRefusal(error: unknown): boolean {
  return error instanceof CLIError && error.status === 429;
}

function sameUrl(left: string, right: string): boolean {
  try { return new URL(left).href === new URL(right).href; } catch { return left === right; }
}

/** Remove every webhook for `callbackUrl` on this database except `keepId`; returns what was removed and what stayed. */
async function removeSameUrl(
  hooks: WebhookRegistrar, space: string, responseResource: string, callbackUrl: string, keepId?: string,
): Promise<{ replaced: string[]; staleRemaining: number } | undefined> {
  const existing = await hooks.list({ space, service: "sql", pathPrefix: responseResource });
  if (!existing.ok) return undefined;
  const replaced: string[] = [];
  let staleRemaining = 0;
  const stale = existing.data.filter((other) =>
    other.id !== keepId && sameUrl(other.callbackUrl, callbackUrl) &&
    other.pathPrefix === responseResource && other.space === space);
  for (const other of stale) {
    const removed = await hooks.unregister(other.id, { target: { space, service: "sql", pathPrefix: responseResource } });
    if (removed.ok) replaced.push(other.id); else staleRemaining += 1;
  }
  return { replaced, staleRemaining };
}

/**
 * One webhook on the agent's response database: any write there (an answer or a message) is delivered.
 * The node makes a new subscription on every registration, so a re-run of `connect` registers the new webhook FIRST
 * and then removes the earlier ones for the same URL: there is no gap, and for a moment both deliver, so a receiver
 * must dedupe on `X-TinyCloud-Event-Id` (the same for every subscription to one event; the delivery id is not).
 * At the node's per-space cap (429) there is no room for the overlap: the earlier ones are removed first, which
 * leaves a gap, and the receipt says so and names the one `feed watch --drain` that closes it.
 */
export async function registerFeedNotify(
  hooks: WebhookRegistrar, space: string, responseResource: string, notify: FeedNotify,
): Promise<FeedNotifyReceipt> {
  const secret = randomBytes(32).toString("hex");
  const registration = {
    space, service: "sql" as const, pathPrefix: responseResource,
    callbackUrl: notify.callbackUrl, secret,
    ...(Object.keys(notify.headers).length === 0 ? {} : { headers: notify.headers }),
  };
  let removedFirst: { replaced: string[]; staleRemaining: number } | undefined;
  let record;
  try {
    record = await registerWebhookChecked(hooks, registration);
  } catch (error) {
    if (!isCapRefusal(error)) throw error;
    removedFirst = await removeSameUrl(hooks, space, responseResource, notify.callbackUrl);
    if (removedFirst === undefined || removedFirst.replaced.length === 0) throw error;
    try {
      record = await registerWebhookChecked(hooks, registration);
    } catch (retry) {
      const reason = retry instanceof Error ? retry.message : "unknown error";
      throw new Error(
        `The node is at its webhook limit, so the earlier webhook for this URL (${removedFirst.replaced.join(", ")}) was removed to make room, but registering the new one failed: ${reason}. ` +
        "Run the same command again, then run `tinycloud feed watch --drain` once to pick up anything written meanwhile.",
      );
    }
  }
  const after = removedFirst ?? await removeSameUrl(hooks, space, responseResource, record.callbackUrl, record.id);
  const replaced = after?.replaced ?? [];
  const staleRemaining = after?.staleRemaining ?? 0;
  return {
    id: record.id,
    callbackUrl: record.callbackUrl,
    headerNames: record.headerNames ?? Object.keys(notify.headers),
    secret,
    replaced,
    ...(staleRemaining === 0 ? {} : { staleRemaining }),
    ...(removedFirst === undefined ? {} : {
      missedWhileReplacing: true as const,
      next: "tinycloud feed watch --drain",
    }),
  };
}
