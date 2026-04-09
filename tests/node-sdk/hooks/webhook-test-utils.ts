import { createHmac, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedWebhookRequest {
  id: string;
  attempt: number;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  jsonBody: unknown;
  receivedAt: number;
}

export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
}

export type WebhookResponsePlan = (
  request: CapturedWebhookRequest,
) => WebhookResponse | Promise<WebhookResponse>;

export class WebhookCallbackServer {
  private readonly requestsLog: CapturedWebhookRequest[] = [];
  private readonly attemptsByPath = new Map<string, number>();
  private readonly server = createServer((req, res) => {
    void this.handleRequest(req, res);
  });
  private listeningPort = 0;
  private lastRequestAt = 0;

  private constructor(private readonly plan: WebhookResponsePlan) {}

  static async start(plan: WebhookResponsePlan = () => ({ status: 200 })) {
    const server = new WebhookCallbackServer(plan);
    await server.listen();
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  get requests(): CapturedWebhookRequest[] {
    return [...this.requestsLog];
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  async waitForRequests(count: number, timeoutMs = 15000): Promise<void> {
    await waitFor(
      () => this.requestsLog.length >= count,
      timeoutMs,
      () =>
        `Timed out waiting for ${count} webhook requests; received ${this.requestsLog.length}`,
    );
  }

  async waitForQuiet(quiescenceMs: number, timeoutMs = 30000): Promise<void> {
    await waitFor(
      () =>
        this.lastRequestAt !== 0 &&
        Date.now() - this.lastRequestAt >= quiescenceMs,
      timeoutMs,
      () =>
        `Timed out waiting for webhook quiet period of ${quiescenceMs}ms; received ${this.requestsLog.length} requests`,
    );
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Webhook server did not expose an address"));
          return;
        }
        this.listeningPort = (address as AddressInfo).port;
        resolve();
      });
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const bodyText = await readRequestBody(req);
    const path = new URL(req.url ?? "/", this.url).pathname;
    const attempt = (this.attemptsByPath.get(path) ?? 0) + 1;
    this.attemptsByPath.set(path, attempt);

    const request: CapturedWebhookRequest = {
      id: randomUUID(),
      attempt,
      method: req.method ?? "GET",
      url: new URL(req.url ?? "/", this.url).toString(),
      path,
      headers: normalizeHeaders(req.headers),
      rawBody: bodyText,
      jsonBody: parseJson(bodyText),
      receivedAt: Date.now(),
    };

    this.requestsLog.push(request);
    this.lastRequestAt = request.receivedAt;

    const response = await this.plan(request);
    if (response.delayMs && response.delayMs > 0) {
      await sleep(response.delayMs);
    }

    res.statusCode = response.status;
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      res.setHeader(name, value);
    }
    if (response.body === undefined || response.body === null) {
      res.end();
      return;
    }

    if (typeof response.body === "string") {
      res.end(response.body);
      return;
    }

    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "application/json");
    }
    res.end(JSON.stringify(response.body));
  }
}

export function verifyWebhookSignature(
  request: CapturedWebhookRequest,
  secret: string,
): boolean {
  const digest = createHmac("sha256", secret).update(request.rawBody).digest();
  const expectedValues = new Set([
    digest.toString("hex"),
    digest.toString("base64"),
    `sha256=${digest.toString("hex")}`,
    `sha256=${digest.toString("base64")}`,
    `v1=${digest.toString("hex")}`,
    `v1=${digest.toString("base64")}`,
  ]);

  for (const [name, value] of Object.entries(request.headers)) {
    if (!/signature|digest/i.test(name)) {
      continue;
    }

    const tokens = value
      .split(/[,\s]/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      if (expectedValues.has(token)) {
        return true;
      }
      const [, tokenValue] = token.split("=", 2);
      if (tokenValue && expectedValues.has(tokenValue)) {
        return true;
      }
    }
    if (expectedValues.has(value)) {
      return true;
    }
  }

  return false;
}

export function findWebhookEvent(
  payload: unknown,
): Record<string, unknown> | null {
  return searchForEvent(payload, 0);
}

function searchForEvent(
  value: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (depth > 5 || !value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.space === "string" &&
    typeof record.service === "string" &&
    typeof record.ability === "string"
  ) {
    return record;
  }

  for (const child of Object.values(record)) {
    const found = searchForEvent(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function normalizeHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[name.toLowerCase()] = value;
      continue;
    }
    if (Array.isArray(value)) {
      normalized[name.toLowerCase()] = value.join(", ");
    }
  }
  return normalized;
}

function parseJson(bodyText: string): unknown {
  if (!bodyText) {
    return undefined;
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<void> {
  const started = Date.now();
  while (true) {
    if (predicate()) {
      return;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(timeoutMessage());
    }
    await sleep(50);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
