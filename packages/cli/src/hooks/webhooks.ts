import { randomBytes } from "node:crypto";
import type { HookServiceName, HookWebhookRecord } from "@tinycloud/sdk-services";
import { cliErrorFromService } from "../output/errors.js";
import {
  invalidInput, readWebhookHeaders, registerWebhookChecked, webhookCallbackUrl,
  type WebhookHeaderFlags, type WebhookHeaderReaders, type WebhookRegistrar,
} from "../lib/webhook-headers.js";

const SERVICES: Record<HookServiceName, true> = { kv: true, sql: true, duckdb: true };

export interface HooksRegisterOptions extends WebhookHeaderFlags {
  url?: string;
  service?: string;
  pathPrefix?: string;
  /** Name of an environment variable holding the HMAC secret; one is generated when omitted. */
  secretEnv?: string;
}

const NAMES = { header: "--header", env: "--header-env", file: "--header-file", stdin: "--header-stdin" } as const;

export interface HooksRegisterInput {
  readonly service: HookServiceName;
  readonly pathPrefix: string | undefined;
  readonly callbackUrl: string;
  readonly headers: Record<string, string>;
  readonly secret: string;
  readonly secretGenerated: boolean;
}

export function parseHookService(service: string | undefined): HookServiceName {
  if (service === undefined || !Object.prototype.hasOwnProperty.call(SERVICES, service)) {
    return invalidInput("--service must be kv, sql or duckdb");
  }
  return service as HookServiceName;
}

/** Everything is checked, and every header value read, before the first request. */
export async function resolveHooksRegister(
  options: HooksRegisterOptions, readers?: WebhookHeaderReaders, env: NodeJS.ProcessEnv = process.env,
): Promise<HooksRegisterInput> {
  const service = parseHookService(options.service);
  if (options.url === undefined) invalidInput("--url is required");
  const callbackUrl = webhookCallbackUrl(options.url, "--url", "--header");
  const headers = await readWebhookHeaders(options, NAMES, readers);
  let secret: string;
  let secretGenerated = false;
  if (options.secretEnv === undefined) {
    secret = randomBytes(32).toString("hex");
    secretGenerated = true;
  } else {
    const fromEnv = (readers?.env ?? env)[options.secretEnv];
    if (fromEnv === undefined || fromEnv.trim().length === 0) invalidInput(`Environment variable ${options.secretEnv} for the signing secret is not set`);
    secret = fromEnv.trim();
  }
  return { service, pathPrefix: options.pathPrefix, callbackUrl, headers, secret, secretGenerated };
}

/** What `register` and `list` show: header names only, whatever else a node might return. */
export interface HookWebhookView {
  readonly id: string;
  readonly space: string;
  readonly service: HookServiceName;
  readonly pathPrefix?: string;
  readonly callbackUrl: string;
  readonly headerNames: string[];
  readonly active: boolean;
  readonly createdAt: string;
}

export function webhookView(record: HookWebhookRecord): HookWebhookView {
  return {
    id: record.id,
    space: record.space,
    service: record.service,
    ...(record.pathPrefix === undefined ? {} : { pathPrefix: record.pathPrefix }),
    callbackUrl: record.callbackUrl,
    headerNames: [...(record.headerNames ?? [])],
    active: record.active,
    createdAt: record.createdAt,
  };
}

export async function registerHookWebhook(
  hooks: WebhookRegistrar, space: string, input: HooksRegisterInput,
): Promise<HookWebhookView & { readonly secret?: string }> {
  const record = await registerWebhookChecked(hooks, {
    space, service: input.service,
    ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
    callbackUrl: input.callbackUrl, secret: input.secret,
    ...(Object.keys(input.headers).length === 0 ? {} : { headers: input.headers }),
  });
  // A generated secret is shown once: the node never returns it. One the owner supplied is never echoed.
  return { ...webhookView(record), ...(input.secretGenerated ? { secret: input.secret } : {}) };
}

export async function listHookWebhooks(
  hooks: WebhookRegistrar, space: string, options: { service?: string; pathPrefix?: string },
): Promise<HookWebhookView[]> {
  const service = options.service === undefined ? undefined : parseHookService(options.service);
  const result = await hooks.list({
    space, ...(service === undefined ? {} : { service }),
    ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
  });
  if (!result.ok) throw cliErrorFromService(result.error);
  return result.data.map(webhookView);
}

export async function removeHookWebhook(
  hooks: WebhookRegistrar, space: string, id: string, options: { service?: string; pathPrefix?: string },
): Promise<{ readonly removed: string }> {
  const service = options.service === undefined ? undefined : parseHookService(options.service);
  if (service === undefined && options.pathPrefix !== undefined) invalidInput("--path-prefix needs --service");
  const result = await hooks.unregister(id, service === undefined
    ? {}
    : { target: { space, service, ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }) } });
  if (!result.ok) throw cliErrorFromService(result.error);
  return { removed: id };
}
