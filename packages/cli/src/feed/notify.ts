import { randomBytes } from "node:crypto";
import type {
  HookWebhookListOptions, HookWebhookRecord, HookWebhookRegistration, HookWebhookUnregisterOptions, Result,
} from "@tinycloud/sdk-services";
import { webhookHeadersProblem } from "@tinycloud/sdk-services";
import { cliErrorFromService } from "../output/errors.js";

export interface FeedNotifyOptions {
  notifyUrl?: string;
  notifyHeader?: string[];
  notifyHeaderEnv?: string[];
}

export interface FeedNotify {
  readonly callbackUrl: string;
  readonly headers: Record<string, string>;
}

function invalid(message: string): never {
  throw cliErrorFromService({ code: "INVALID_INPUT", message });
}

/** Header values come from the command line or the environment and are never echoed in an error. */
export function parseFeedNotify(options: FeedNotifyOptions, env: NodeJS.ProcessEnv = process.env): FeedNotify | undefined {
  const given = (options.notifyHeader?.length ?? 0) + (options.notifyHeaderEnv?.length ?? 0);
  if (options.notifyUrl === undefined) {
    if (given > 0) invalid("--notify-header and --notify-header-env need --notify-url");
    return undefined;
  }
  let url: URL;
  try { url = new URL(options.notifyUrl); } catch { return invalid("--notify-url must be an absolute https URL"); }
  if (url.protocol !== "https:") invalid("--notify-url must be an https URL");
  // A credential belongs in --notify-header: a URL is listed and logged, a header value is not.
  if (url.username !== "" || url.password !== "") invalid("--notify-url must not contain credentials; pass them with --notify-header");

  const headers: Record<string, string> = {};
  const add = (name: string, headerValue: string) => {
    const key = name.toLowerCase();
    if (Object.keys(headers).some((existing) => existing.toLowerCase() === key)) invalid(`Notify header "${name}" is given more than once`);
    headers[name] = headerValue;
  };
  for (const entry of options.notifyHeader ?? []) {
    const split = entry.indexOf(":");
    if (split <= 0) invalid("--notify-header must be Name:value");
    add(entry.slice(0, split).trim(), entry.slice(split + 1).trim());
  }
  for (const entry of options.notifyHeaderEnv ?? []) {
    const split = entry.indexOf("=");
    if (split <= 0) invalid("--notify-header-env must be Name=ENV_VAR");
    const name = entry.slice(0, split).trim();
    const variable = entry.slice(split + 1).trim();
    const fromEnv = env[variable];
    if (fromEnv === undefined || fromEnv.trim().length === 0) invalid(`Environment variable ${variable} for notify header "${name}" is not set`);
    add(name, fromEnv.trim());
  }
  const problem = webhookHeadersProblem(headers);
  if (problem !== undefined) invalid(problem);
  return { callbackUrl: url.toString(), headers };
}

interface WebhookRegistrar {
  register(webhook: HookWebhookRegistration): Promise<Result<HookWebhookRecord>>;
  list(options?: HookWebhookListOptions): Promise<Result<HookWebhookRecord[]>>;
  unregister(id: string, options?: HookWebhookUnregisterOptions): Promise<Result<void>>;
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
  const result = await hooks.register({
    space, service: "sql", pathPrefix: responseResource,
    callbackUrl: notify.callbackUrl, secret,
    ...(Object.keys(notify.headers).length === 0 ? {} : { headers: notify.headers }),
  });
  if (!result.ok) throw cliErrorFromService(result.error);
  // A node without header support ignores the field and registers a webhook that would call the agent
  // unauthenticated, failing silently. It must confirm every name back, or the webhook is withdrawn.
  const stored = (result.data.headerNames ?? []).map((name) => name.toLowerCase());
  if (Object.keys(notify.headers).some((name) => !stored.includes(name.toLowerCase()))) {
    await hooks.unregister(result.data.id, { target: { space, service: "sql", pathPrefix: responseResource } });
    throw new Error("The node did not store the notify headers (it may predate webhook headers); the webhook was removed");
  }
  const replaced: string[] = [];
  let staleRemaining = 0;
  const existing = await hooks.list({ space, service: "sql", pathPrefix: responseResource });
  if (existing.ok) {
    const stale = existing.data.filter((record) =>
      record.id !== result.data.id && record.callbackUrl === result.data.callbackUrl &&
      record.pathPrefix === responseResource && record.space === space);
    for (const record of stale) {
      const removed = await hooks.unregister(record.id, { target: { space, service: "sql", pathPrefix: responseResource } });
      if (removed.ok) replaced.push(record.id); else staleRemaining += 1;
    }
  }
  return {
    id: result.data.id,
    callbackUrl: result.data.callbackUrl,
    headerNames: result.data.headerNames ?? Object.keys(notify.headers),
    secret,
    replaced,
    ...(staleRemaining === 0 ? {} : { staleRemaining }),
  };
}
