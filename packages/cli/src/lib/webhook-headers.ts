import { readFile } from "node:fs/promises";
import { webhookHeadersProblem } from "@tinycloud/sdk-services";
import type {
  HookWebhookListOptions, HookWebhookRecord, HookWebhookRegistration, HookWebhookUnregisterOptions, Result,
} from "@tinycloud/sdk-services";
import { cliErrorFromService } from "../output/errors.js";

/**
 * Webhook header values are credentials. They are accepted from a flag, an environment variable, a file or
 * stdin, are checked client-side before any request, and never appear in an error, a log or a saved file:
 * every message below names the header or the flag, never the value.
 */
export interface WebhookHeaderFlags {
  /** `Name: value` */
  header?: string[];
  /** `Name=ENV_VAR` */
  headerEnv?: string[];
  /** `Name=path`: the file's contents are the value */
  headerFile?: string[];
  /** `Name`: the value is read from stdin (at most one header) */
  headerStdin?: string[];
}

export interface WebhookHeaderFlagNames {
  readonly header: string;
  readonly env: string;
  readonly file: string;
  readonly stdin: string;
}

export interface WebhookHeaderReaders {
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (path: string) => Promise<string>;
  readonly readStdin: () => Promise<string>;
}

export function invalidInput(message: string): never {
  throw cliErrorFromService({ code: "INVALID_INPUT", message });
}

const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const ENV_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A header name for an error message, only when it is a valid one: a mistyped flag can put a credential where a name goes. */
export function shownName(name: string): string {
  return HEADER_NAME_TOKEN.test(name) ? `"${name}"` : "(not a valid header name)";
}

/** Likewise for an environment variable name. */
export function shownVariable(variable: string): string {
  return ENV_VARIABLE.test(variable) ? variable : "(not a valid variable name)";
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) invalidInput("stdin is a terminal: pipe the header value in");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

const DEFAULT_READERS: WebhookHeaderReaders = {
  env: process.env,
  readFile: (path) => readFile(path, "utf8"),
  readStdin: readStdinText,
};

/** `true` when any header flag was given, so a caller can refuse them without a URL. */
export function givesWebhookHeaders(flags: WebhookHeaderFlags): boolean {
  return (flags.header?.length ?? 0) + (flags.headerEnv?.length ?? 0) + (flags.headerFile?.length ?? 0) + (flags.headerStdin?.length ?? 0) > 0;
}

/** A webhook URL is listed and logged, so it must be https and carry no credential. */
export function webhookCallbackUrl(raw: string, flag: string, headerFlag: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return invalidInput(`${flag} must be an absolute https URL`); }
  if (url.protocol !== "https:") invalidInput(`${flag} must be an https URL`);
  if (url.username !== "" || url.password !== "") invalidInput(`${flag} must not contain credentials; pass them with ${headerFlag}`);
  return url.toString();
}

/** Resolve every header source into one map, then validate it exactly as the node will. */
export async function readWebhookHeaders(
  flags: WebhookHeaderFlags,
  names: WebhookHeaderFlagNames,
  readers: WebhookHeaderReaders = DEFAULT_READERS,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const add = (name: string, value: string) => {
    const key = name.toLowerCase();
    if (Object.keys(headers).some((existing) => existing.toLowerCase() === key)) invalidInput(`Header ${shownName(name)} is given more than once`);
    headers[name] = value.trim();
  };
  const pair = (entry: string, flag: string, shape: string): [string, string] => {
    const split = entry.indexOf("=");
    if (split <= 0) return invalidInput(`${flag} must be ${shape}`);
    return [entry.slice(0, split).trim(), entry.slice(split + 1).trim()];
  };

  for (const entry of flags.header ?? []) {
    const split = entry.indexOf(":");
    if (split <= 0) invalidInput(`${names.header} must be "Name: value"`);
    add(entry.slice(0, split).trim(), entry.slice(split + 1));
  }
  for (const entry of flags.headerEnv ?? []) {
    const [name, variable] = pair(entry, names.env, "Name=ENV_VAR");
    const fromEnv = readers.env[variable];
    if (fromEnv === undefined || fromEnv.trim().length === 0) invalidInput(`Environment variable ${shownVariable(variable)} for header ${shownName(name)} is not set`);
    add(name, fromEnv);
  }
  for (const entry of flags.headerFile ?? []) {
    const [name, path] = pair(entry, names.file, "Name=path");
    let content: string;
    // The reader's own error can quote the path or part of the content; say only which header.
    try { content = await readers.readFile(path); } catch { return invalidInput(`Could not read the file for header ${shownName(name)}`); }
    if (content.trim().length === 0) invalidInput(`The file for header ${shownName(name)} is empty`);
    add(name, content);
  }
  const fromStdin = flags.headerStdin ?? [];
  if (fromStdin.length > 1) invalidInput(`${names.stdin} can be given once: stdin holds one value`);
  for (const name of fromStdin) {
    if (name.trim().length === 0) invalidInput(`${names.stdin} needs a header name`);
    const content = await readers.readStdin();
    if (content.trim().length === 0) invalidInput(`Nothing was piped in for header ${shownName(name.trim())}`);
    add(name.trim(), content);
  }

  const problem = webhookHeadersProblem(headers);
  if (problem !== undefined) invalidInput(problem);
  return headers;
}

export interface WebhookRegistrar {
  register(webhook: HookWebhookRegistration): Promise<Result<HookWebhookRecord>>;
  list(options?: HookWebhookListOptions): Promise<Result<HookWebhookRecord[]>>;
  unregister(id: string, options?: HookWebhookUnregisterOptions): Promise<Result<void>>;
}

/**
 * Register one webhook. A node without header support ignores the field and registers a webhook that would call
 * the receiver unauthenticated, failing silently, so the node must confirm every header name back or the
 * webhook is withdrawn.
 */
export async function registerWebhookChecked(
  hooks: WebhookRegistrar, webhook: HookWebhookRegistration,
): Promise<HookWebhookRecord> {
  const sent = Object.keys(webhook.headers ?? {});
  const result = await hooks.register(webhook);
  if (!result.ok) throw cliErrorFromService(result.error);
  const stored = (result.data.headerNames ?? []).map((name) => name.toLowerCase());
  if (sent.some((name) => !stored.includes(name.toLowerCase()))) {
    await hooks.unregister(result.data.id, {
      target: { space: webhook.space, service: webhook.service, ...(webhook.pathPrefix === undefined ? {} : { pathPrefix: webhook.pathPrefix }) },
    });
    throw new Error("The node did not store the webhook headers (it may predate webhook headers); the webhook was removed");
  }
  return result.data;
}
