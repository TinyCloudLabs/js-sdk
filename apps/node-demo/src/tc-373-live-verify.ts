#!/usr/bin/env bun
/**
 * TC-373 live verification: proves the account-bootstrap seed-spaces
 * batching end-to-end against a real node, using a throwaway key.
 *
 * Wraps global fetch to count/log every request made during a cold
 * signIn(), classifying each /invoke call's body shape (multipart batch vs
 * single JSON/text) so the collapsed KV batch write and the collapsed SQL
 * index write are visible in the trace. Then reads all 5 seeded space
 * records back through the canonical (non-index) read path to confirm they
 * are readable and correct.
 *
 * Usage:
 *   bun run src/tc-373-live-verify.ts
 *   TINYCLOUD_HOST=https://... bun run src/tc-373-live-verify.ts
 */
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { randomBytes } from "crypto";

const HOST = process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz";
const original = globalThis.fetch;
let n = 0;

interface RequestLog {
  method: string;
  path: string;
  status: number;
  ms: number;
  bodyKind: string;
}
const requests: RequestLog[] = [];

function bodyKind(init?: RequestInit): string {
  const body = init?.body;
  if (!body) return "none";
  if (body instanceof FormData) {
    const parts = [...body.keys()];
    return `multipart(${parts.length} part${parts.length === 1 ? "" : "s"})`;
  }
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.statements)) {
        return `json-batch(${parsed.statements.length} stmt${parsed.statements.length === 1 ? "" : "s"})`;
      }
      if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
        return `json-${parsed.action}`;
      }
      return "json";
    } catch {
      return "text";
    }
  }
  return "binary";
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = init?.method ?? (typeof input === "object" ? input?.method : "GET") ?? "GET";
  const kind = bodyKind(init);
  const i = ++n;
  const started = Date.now();
  try {
    const res = await original(input as any, init);
    const ms = Date.now() - started;
    requests.push({ method, path: url.replace(HOST, ""), status: res.status, ms, bodyKind: kind });
    console.log(
      `  [${String(i).padStart(2)}] ${String(method).padEnd(5)} ${String(ms).padStart(6)}ms  ${res.status}  ${kind.padEnd(18)}  ${url.replace(HOST, "")}`,
    );
    return res;
  } catch (error) {
    const ms = Date.now() - started;
    requests.push({ method, path: url.replace(HOST, ""), status: -1, ms, bodyKind: kind });
    console.log(
      `  [${String(i).padStart(2)}] ${String(method).padEnd(5)} ${String(ms).padStart(6)}ms  ERR   ${kind.padEnd(18)}  ${url.replace(HOST, "")}  ${error}`,
    );
    throw error;
  }
}) as typeof fetch;

console.log(`=== TC-373 live verify against ${HOST} ===\n`);

const key = `0x${randomBytes(32).toString("hex")}`;
const node = new TinyCloudNode({
  privateKey: key,
  host: HOST,
  prefix: "tc-373-verify",
  autoCreateSpace: true,
});

const started = Date.now();
await node.signIn();
const signInMs = Date.now() - started;

console.log(`\ntotal signIn: ${signInMs}ms, ${requests.length} requests`);
console.log(`bootstrap skipped: ${node.bootstrapSkipped}`);
if (node.bootstrapSkipped) {
  console.log(`bootstrap status:`, node.bootstrapStatus);
}

const invokeRequests = requests.filter((r) => r.path === "/invoke" && r.method === "POST");
const multipartBatch = invokeRequests.filter((r) => r.bodyKind.startsWith("multipart"));
const jsonBatchSql = invokeRequests.filter((r) => r.bodyKind.startsWith("json-batch"));

console.log(`\n/invoke POST calls: ${invokeRequests.length}`);
console.log(`  multipart KV batch writes: ${multipartBatch.length} (expect 1, covering all 5 spaces)`);
console.log(`  multi-statement SQL batch calls: ${jsonBatchSql.length}`);

let failed = false;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed = true;
}

console.log("\n=== verifying all 5 seeded spaces ===");
assert(
  "bootstrap did not skip",
  node.bootstrapSkipped === false,
  JSON.stringify(node.bootstrapStatus),
);
assert(
  "exactly one multipart KV batch write",
  multipartBatch.length === 1,
  `got ${multipartBatch.length}`,
);
if (multipartBatch.length === 1) {
  assert(
    "batch write covers exactly 5 parts",
    multipartBatch[0]!.bodyKind === "multipart(5 parts)",
    multipartBatch[0]!.bodyKind,
  );
}

const expectedNames = ["default", "applications", "account", "secrets", "public"];
const spacesResult = await node.account.spaces.list();
assert(
  "account.spaces.list() ok (canonical KV read, not the SQL index)",
  spacesResult.ok,
  spacesResult.ok ? "" : JSON.stringify((spacesResult as any).error),
);
if (spacesResult.ok) {
  assert(
    "all 5 spaces present",
    spacesResult.data.length === 5,
    `got ${spacesResult.data.length}: ${spacesResult.data.map((s) => s.name).join(",")}`,
  );
  for (const name of expectedNames) {
    const found = spacesResult.data.find((s) => s.name === name);
    assert(`space "${name}" registered`, Boolean(found), found ? `spaceId=${found.spaceId}` : "missing");
    if (found) {
      assert(
        `space "${name}" ownerDid matches signed-in identity`,
        found.ownerDid === node.did,
        `${found.ownerDid} vs ${node.did}`,
      );
      assert(`space "${name}" status active`, found.status === "active");
    }
  }
}

// Index status: the multi-row index write should have landed too (best
// effort, but expected to succeed on a healthy node).
const indexStatus = await node.account.index.status();
console.log(`\nindex status:`, indexStatus.ok ? indexStatus.data : (indexStatus as any).error);

console.log(`\nRESULT: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
