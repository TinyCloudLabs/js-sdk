import { randomBytes } from "node:crypto";
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
}

/**
 * One webhook on the agent's response database: any write there (an answer or a message) is delivered.
 * The node makes a new subscription on every registration, so an earlier one for the same URL on this
 * database (a re-run of `connect`) is removed once the new one exists, leaving no gap and no duplicate wake-up.
 */
export async function registerFeedNotify(
  hooks: WebhookRegistrar, space: string, responseResource: string, notify: FeedNotify,
): Promise<FeedNotifyReceipt> {
  const secret = randomBytes(32).toString("hex");
  const record = await registerWebhookChecked(hooks, {
    space, service: "sql", pathPrefix: responseResource,
    callbackUrl: notify.callbackUrl, secret,
    ...(Object.keys(notify.headers).length === 0 ? {} : { headers: notify.headers }),
  });
  const replaced: string[] = [];
  let staleRemaining = 0;
  const existing = await hooks.list({ space, service: "sql", pathPrefix: responseResource });
  if (existing.ok) {
    const stale = existing.data.filter((other) =>
      other.id !== record.id && other.callbackUrl === record.callbackUrl &&
      other.pathPrefix === responseResource && other.space === space);
    for (const other of stale) {
      const removed = await hooks.unregister(other.id, { target: { space, service: "sql", pathPrefix: responseResource } });
      if (removed.ok) replaced.push(other.id); else staleRemaining += 1;
    }
  }
  return {
    id: record.id,
    callbackUrl: record.callbackUrl,
    headerNames: record.headerNames ?? Object.keys(notify.headers),
    secret,
    replaced,
    ...(staleRemaining === 0 ? {} : { staleRemaining }),
  };
}
