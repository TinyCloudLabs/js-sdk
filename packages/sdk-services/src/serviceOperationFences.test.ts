import { expect, test } from "bun:test";
import { SQLService } from "./sql/SQLService";
import { DuckDbService } from "./duckdb/DuckDbService";
import { HooksService } from "./hooks/HooksService";
import { SecretsService } from "./secrets/SecretsService";
import { TinyCloudQuota } from "./quota/TinyCloudQuota";
import { EncryptionService } from "./encryption/EncryptionService";
import { encryptToNetwork } from "./encryption/envelope";
import { base64Encode, canonicalize } from "./encryption/canonical";
import type { EncryptionCrypto, NetworkDescriptor } from "./encryption/types";
import type { IServiceContext, ServiceSession } from "./types";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const session = (spaceId: string): ServiceSession => ({
  spaceId, delegationHeader: { Authorization: "test" }, delegationCid: spaceId, verificationMethod: "did:key:test", jwk: {},
});
function context() {
  return {
    session: session("A"), isAuthenticated: true, hosts: ["https://unused.invalid"],
    abortSignal: new AbortController().signal,
    invoke: () => ({}), fetch: async () => Response.json({ rows: [] }),
    emit: () => {}, on: () => () => {}, getService: () => undefined,
  } as unknown as { -readonly [K in keyof IServiceContext]: IServiceContext[K] } & { session: ServiceSession };
}

for (const [label, make, start] of [
  ["SQL", () => new SQLService(), (s: any) => s.query("SELECT 1")],
  ["DuckDB", () => new DuckDbService(), (s: any) => s.query("SELECT 1")],
  ["DuckDB import", () => new DuckDbService(), (s: any) => s.importOnDb("db", new Uint8Array())],
  ["Hooks register", () => new HooksService(), (s: any) => s.register({ space: "A", service: "kv", callbackUrl: "https://unused.invalid", secret: "secret" })],
  ["Hooks list", () => new HooksService(), (s: any) => s.list()],
  ["Hooks unregister", () => new HooksService(), (s: any) => s.unregister("id")],
] as const) {
  test(`${label} retry callbacks keep the entry session`, async () => {
    const ctx = context();
    const entered = gate<void>();
    const resume = gate<void>();
    const signed: ServiceSession[] = [];
    ctx.invoke = (value) => { signed.push(value); return {}; };
    ctx.invokeWithRetry = async (_url, build) => {
      build(); entered.resolve(); await resume.promise; build();
      return Response.json([]);
    };
    const service = make(); service.initialize(ctx);
    const original = ctx.session;
    const pending = start(service);
    await entered.promise;
    ctx.session = session("B"); resume.resolve(); await pending;
    expect(signed).toEqual([original, original]);
  });
}

test("SQL error metadata keeps the signed space after an awaited body", async () => {
  const ctx = context(); const entered = gate<void>(); const body = gate<string>();
  ctx.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: () => {
    entered.resolve(); return body.promise;
  } }) as any;
  const service = new SQLService(); service.initialize(ctx);
  const pending = service.queryOnDb("db", "SELECT 1");
  await entered.promise; ctx.session = session("B");
  body.resolve("Unauthorized Action: A/sql/db / tinycloud.sql/read");
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.meta?.resource).toBe("A/sql/db");
});

for (const stage of ["probe", "list", "schema", "migration"] as const) {
  test(`SQL migrations stop after ${stage} handoff and preserve the new lock`, async () => {
    const ctx = context(); const service = new SQLService(); service.initialize(ctx);
    const entered = gate<void>(); const resume = gate<void>();
    let child = 0;
    const stop = { probe: 1, list: 2, schema: 2, migration: 3 }[stage];
    const signals: AbortSignal[] = [];
    const query = async (_db: string, _sql: string, _params: unknown, options: any) => {
      signals.push(options.signal); child++;
      if (child === stop) { entered.resolve(); await resume.promise; }
      return { ok: true, data: { rows: stage === "list" && child === 1 ? [["table"]] : [] } } as any;
    };
    service.queryOnDb = query;
    service.batchOnDb = async (_db, _statements, options) => {
      signals.push(options!.signal!); child++;
      if (child === stop) { entered.resolve(); await resume.promise; }
      return { ok: true, data: {} } as any;
    };
    const options = { namespace: "app", migrations: [{ id: "1", sql: ["CREATE TABLE t(x)"] }, { id: "2", sql: ["INSERT INTO t VALUES (1)"] }] };
    const old = service.applyMigrationsOnDb("db", options);
    await entered.promise;
    const oldCalls = child;
    ctx.session = session("B");
    const newEntered = gate<void>(); const newResume = gate<void>(); let newCalls = 0;
    service.queryOnDb = async () => { newCalls++; newEntered.resolve(); await newResume.promise; return { ok: true, data: { rows: [] } } as any; };
    const fresh = service.applyMigrationsOnDb("db", { namespace: "app", migrations: [] });
    await newEntered.promise;
    resume.resolve(); const stale = await old;
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("ABORTED");
    expect(child).toBe(oldCalls);
    expect(new Set(signals).size).toBe(1);
    const joined = service.applyMigrationsOnDb("db", { namespace: "app", migrations: [] });
    newResume.resolve(); expect((await fresh).ok).toBe(true); await joined;
    expect(newCalls).toBe(1);
  });
}

test("Secrets listAll keeps its initial vault across pages", async () => {
  const entered = gate<void>(); const resume = gate<void>(); let calls = 0; let reads = 0;
  const vault = { listPage: async () => {
    calls++;
    if (calls === 1) { entered.resolve(); await resume.promise; return { ok: true, data: { keys: ["FIRST"], truncated: true, nextCursor: "next" } }; }
    return { ok: true, data: { keys: ["SECOND"], truncated: false } };
  } };
  let current = vault;
  const service = new SecretsService(() => { reads++; return current as any; });
  const pending = service.listAll(); await entered.promise;
  current = { listPage: async () => { throw new Error("new vault used"); } };
  resume.resolve(); const result = await pending;
  expect(result.ok).toBe(true); expect(calls).toBe(2); expect(reads).toBe(1);
});

for (const kind of ["duck", "hooks", "quota"] as const) {
  test(`${kind} releases discarded bodies before returning`, async () => {
    const entered = gate<void>(); const cleanup = gate<void>(); let done = false;
    const response = new Response(new ReadableStream({ cancel() { entered.resolve(); return cleanup.promise; } }), { status: kind === "quota" ? 503 : 200 });
    const ctx = context(); ctx.fetch = async () => response;
    let pending: Promise<unknown>;
    if (kind === "quota") {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => response) as any;
      const quota = new TinyCloudQuota(); quota.setQuotaUrl("https://unused.invalid");
      pending = quota.getQuota("A").finally(() => { globalThis.fetch = original; });
    } else {
      const service = kind === "duck" ? new DuckDbService() : new HooksService(); service.initialize(ctx);
      pending = service instanceof DuckDbService ? service.importOnDb("db", new Uint8Array()) : service.unregister("id");
    }
    const completed = pending.then(() => { done = true; });
    await entered.promise; expect(done).toBe(false); cleanup.resolve(); await completed; expect(done).toBe(true);
  });
}

const networkId = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const crypto: EncryptionCrypto = {
  sha256: () => new Uint8Array(32), randomBytes: (n) => new Uint8Array(n).fill(1),
  x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
  x25519Dh: () => new Uint8Array(32), authEncrypt: (_k, data) => data,
  authDecrypt: (_k, data) => data, sealToNetworkKey: (_k, data) => data,
  openWithReceiverKey: (_k, data) => data, verifyNodeSignature: () => true,
};
const descriptor: NetworkDescriptor = {
  networkId, ownerDid: "did:key:z6MkPrincipal", name: "default", members: [{ nodeId: "did:key:z6MkNode", role: "primary" }],
  threshold: { n: 1, t: 1 }, state: "active", publicEncryptionKey: base64Encode(new Uint8Array(32)),
  alg: "x25519-aes256gcm/v1", keyVersion: 1, keyBackend: "local-one-of-one", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
for (const stage of ["discovery", "sign", "transport"] as const) {
  test(`standalone decrypt sign-out fences ${stage}`, async () => {
    const entered = gate<void>(); const resume = gate<void>(); let signs = 0; let posts = 0; let transportSignal: AbortSignal | undefined;
    const service = new EncryptionService({ crypto,
      node: { fetchByNetworkId: async () => { if (stage === "discovery") { entered.resolve(); await resume.promise; } return descriptor; } },
      signer: { signDecryptInvocation: async (input) => { signs++; if (stage === "sign") { entered.resolve(); await resume.promise; } return { authorization: "test", invocationCid: "test", canonicalBody: canonicalize(input.body as never) }; } },
      transport: { postDecrypt: async (input) => { posts++; transportSignal = input.signal; if (stage === "transport") { entered.resolve(); await resume.promise; } throw new Error("fixture transport end"); } },
    });
    const { envelope } = encryptToNetwork(crypto, { networkId, networkPublicKey: new Uint8Array(32), plaintext: new Uint8Array([1]) });
    const pending = service.decryptEnvelope(envelope, { proofs: [] });
    await entered.promise; service.onSignOut();
    if (stage === "transport") expect(transportSignal?.aborted).toBe(true);
    resume.resolve(); expect((await pending).ok).toBe(false);
    expect(signs).toBe(stage === "discovery" ? 0 : 1); expect(posts).toBe(stage === "transport" ? 1 : 0);
  });
}

for (const method of ["register", "list", "unregister"] as const) {
  test(`Hooks ${method} retains its abort signal through body work`, async () => {
    const ctx = context(); const entered = gate<void>(); const resume = gate<void>();
    let signal: AbortSignal | undefined;
    ctx.fetch = async (_url, init) => {
      signal = init?.signal;
      return { ok: true, status: 200, body: method === "unregister" ? {
        cancel: async () => { entered.resolve(); await resume.promise; },
      } : undefined, json: async () => { entered.resolve(); await resume.promise; return []; } } as any;
    };
    const service = new HooksService(); service.initialize(ctx);
    const pending = method === "register" ? service.register({ space: "A", service: "kv", callbackUrl: "https://unused.invalid", secret: "secret" })
      : method === "list" ? service.list() : service.unregister("id");
    await entered.promise; service.onSignOut(); expect(signal?.aborted).toBe(true);
    resume.resolve(); await pending;
  });
}
