import { createServer } from "node:http";
import open from "open";

export interface CredentialCliHandoffResult {
  readonly completed: boolean;
  readonly credentialDigest?: string;
}

function opaqueState(): string { return crypto.randomUUID(); }

function parseCompletion(body: string, state: string, requestId: string): boolean {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 4 && message.type === "tinycloud-credential-complete" && message.version === 1 && message.state === state && message.requestId === requestId;
}

/** Hosted credentials.org handoff with an independent CLI-side recheck. */
export async function runCredentialCliHandoff(input: {
  readonly hostedOrigin: string;
  readonly issuerOrigin: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<CredentialCliHandoffResult> {
  const state = opaqueState();
  const requestId = opaqueState();
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const server = createServer();
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("credential handoff timed out")), input.timeoutMs ?? 120_000);
    server.on("request", (request, response) => {
      if (request.method !== "POST" || request.url !== "/complete") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const accepted = parseCompletion(Buffer.concat(chunks).toString("utf8"), state, requestId);
        response.writeHead(accepted ? 204 : 400).end();
        if (accepted) { clearTimeout(timer); resolve(); }
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === "string") { server.close(); throw new Error("credential handoff unavailable"); }
  const callback = `http://127.0.0.1:${address.port}/complete`;
  const hosted = new URL("/credentials/ensure", input.hostedOrigin);
  hosted.searchParams.set("state", state);
  hosted.searchParams.set("request", requestId);
  hosted.searchParams.set("callback", callback);
  await open(hosted.href);
  try { await completed; } finally { server.close(); }

  const recheck = await fetchFn(new URL(`/v1/credentials/requests/${requestId}`, input.issuerOrigin), { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  if (!recheck.ok) throw new Error("credential handoff recheck failed");
  const result = await recheck.json() as Record<string, unknown>;
  if (result.type !== "TinyCloudCredentialRequestStatus" || result.version !== 1 || result.state !== "complete" || typeof result.credentialDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.credentialDigest)) throw new Error("credential handoff status is invalid");
  return { completed: true, credentialDigest: result.credentialDigest };
}
