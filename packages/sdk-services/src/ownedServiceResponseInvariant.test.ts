import { expect, test } from "bun:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceContext } from "./context";
import { KVService } from "./kv/KVService";
import { SQLService } from "./sql/SQLService";
import { DuckDbService } from "./duckdb/DuckDbService";
import { HooksService } from "./hooks/HooksService";
import { NamedKeyClient, type NamedKeyClientConfig, type NamedKeyEnvelope } from "./encryption/namedKeys";
import { TinyCloudQuota } from "./quota/TinyCloudQuota";
import { canonicalHashHex } from "./encryption/canonical";
import type { EncryptionCrypto } from "./encryption/types";
import type { FetchFunction, IServiceContext, ServiceSession } from "./types";

const session: ServiceSession = {
  delegationHeader: { Authorization: "test" }, delegationCid: "test",
  spaceId: "tinycloud:pkh:eip155:1:0x1:default", verificationMethod: "test", jwk: {},
};
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
};
type Operation = { run(): Promise<unknown>; abort(): void; restore?(): void };
type Factory = (context: IServiceContext, owner: ServiceContext, fetch: FetchFunction, host: string) => Operation;

function serviceCase<S extends { initialize(context: IServiceContext): void; onSignOut(): void }>(
  create: () => S, run: (service: S) => Promise<unknown>,
): Factory {
  return (context) => {
    const service = create(); service.initialize(context);
    return { run: () => run(service), abort: () => service.onSignOut() };
  };
}

// One row per owned HTTP consumer, including the shared batchRead implementation.
const cases: Record<string, Factory> = {
  "kv.batchRead": serviceCase(() => new KVService(), (s) => s.batchGet(["note", "other"])),
  "kv.getFromNetwork": serviceCase(() => new KVService(), (s) => s.get("note")),
  "kv.putToNetwork": serviceCase(() => new KVService(), (s) => s.put("note", "value")),
  "kv.batchPutToNetwork": serviceCase(() => new KVService(), (s) => s.batchPut([{ key: "note", value: "value" }])),
  "kv.listFromNetwork": serviceCase(() => new KVService(), (s) => s.list()),
  "kv.changes": serviceCase(() => new KVService(), (s) => s.changes({ prefix: "notes/" })),
  "kv.deleteFromNetwork": serviceCase(() => new KVService(), (s) => s.delete("note")),
  "kv.head": serviceCase(() => new KVService(), (s) => s.head("note")),
  "kv.createSignedReadUrl": serviceCase(() => new KVService(), (s) => s.createSignedReadUrl("note")),
  "sql.queryOnDb": serviceCase(() => new SQLService(), (s) => s.queryOnDb("db", "SELECT 1")),
  "sql.executeOnDb": serviceCase(() => new SQLService(), (s) => s.executeOnDb("db", "CREATE TABLE t(x)")),
  "sql.batchOnDb": serviceCase(() => new SQLService(), (s) => s.batchOnDb("db", [{ sql: "SELECT 1" }])),
  "sql.executeStatementOnDb": serviceCase(() => new SQLService(), (s) => s.executeStatementOnDb("db", "statement")),
  "sql.exportDb": serviceCase(() => new SQLService(), (s) => s.exportDb("db")),
  "duckdb.queryOnDb": serviceCase(() => new DuckDbService(), (s) => s.queryOnDb("db", "SELECT 1")),
  "duckdb.queryArrowOnDb": serviceCase(() => new DuckDbService(), (s) => s.queryArrowOnDb("db", "SELECT 1")),
  "duckdb.executeOnDb": serviceCase(() => new DuckDbService(), (s) => s.executeOnDb("db", "CREATE TABLE t(x)")),
  "duckdb.batchOnDb": serviceCase(() => new DuckDbService(), (s) => s.batchOnDb("db", [{ sql: "SELECT 1" }])),
  "duckdb.executeStatementOnDb": serviceCase(() => new DuckDbService(), (s) => s.executeStatementOnDb("db", "statement")),
  "duckdb.describeDb": serviceCase(() => new DuckDbService(), (s) => s.describeDb("db")),
  "duckdb.exportOnDb": serviceCase(() => new DuckDbService(), (s) => s.exportOnDb("db")),
  "duckdb.importOnDb": serviceCase(() => new DuckDbService(), (s) => s.importOnDb("db", new Uint8Array([1]))),
  "hooks.register": serviceCase(() => new HooksService(), (s) => s.register({
    space: session.spaceId, service: "kv", pathPrefix: "notes/", callbackUrl: "https://callback.invalid", secret: "test",
  })),
  "hooks.list": serviceCase(() => new HooksService(), (s) => s.list()),
  "hooks.unregister": serviceCase(() => new HooksService(), (s) => s.unregister("webhook")),
};

const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default";
// Only pre-HTTP crypto is reached: each target response rejects before parsing.
const crypto = {
  sha256: () => new Uint8Array(32), randomBytes: (n: number) => new Uint8Array(n),
  x25519FromSeed: (seed: Uint8Array) => ({ publicKey: seed, privateKey: seed }),
} as unknown as EncryptionCrypto;
const envelope: NamedKeyEnvelope = {
  v: 2, networkId, keyPath: "secrets/test", alg: "x25519-aes256gcm/v1", keyVersion: 1,
  encryptedSymmetricKey: "AQ==", encryptedSymmetricKeyHash: canonicalHashHex(crypto.sha256, "AQ=="), ciphertext: "Ag==",
};

function namedCase(run: (client: NamedKeyClient) => Promise<unknown>): Factory {
  return (_context, owner, fetch, host) => {
    const client = new NamedKeyClient({
      host, crypto, defaultNetworkId: () => networkId,
      fetch: fetch as unknown as NamedKeyClientConfig["fetch"],
      assertActive: () => {
        if (owner.session !== session) throw Object.assign(new Error("Graph retired"), { name: "AbortError" });
      },
      signInvocation: async () => ({ authorization: "test", invocationCid: "test" }),
    });
    return { run: () => run(client), abort: () => owner.setSession(null) };
  };
}
cases["namedKeys.readNodeInfo"] = namedCase((s) => s.getPublicKey("secrets/test"));
cases["namedKeys.getPublicKey"] = namedCase((s) => s.getPublicKey("secrets/test"));
cases["namedKeys.describeBody"] = namedCase((s) => s.describeKey("secrets/test"));
cases["namedKeys.admin"] = namedCase((s) => s.createKey("secrets/test"));
cases["namedKeys.decryptKey"] = namedCase((s) => s.decrypt(envelope));
cases["quota.getQuota"] = (_context, owner, fetch, host) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  const quota = new TinyCloudQuota(); quota.setQuotaUrl(host);
  return {
    run: () => quota.getQuota(session.spaceId), abort: () => owner.setSession(null),
    restore: () => { globalThis.fetch = original; },
  };
};

// Keep the HTTP-site inventory explicit so a subset cannot silently replace the matrix.
const httpMethods = {
  kv: ["batchRead", "getFromNetwork", "putToNetwork", "batchPutToNetwork", "listFromNetwork", "changes", "deleteFromNetwork", "head", "createSignedReadUrl"],
  sql: ["queryOnDb", "executeOnDb", "batchOnDb", "executeStatementOnDb", "exportDb"],
  duckdb: ["queryOnDb", "queryArrowOnDb", "executeOnDb", "batchOnDb", "executeStatementOnDb", "describeDb", "exportOnDb", "importOnDb"],
  hooks: ["register", "list", "unregister"],
  namedKeys: ["readNodeInfo", "getPublicKey", "describeBody", "admin", "decryptKey"],
  quota: ["getQuota"],
};
test("invariant matrix covers every owned service HTTP consumer", () => {
  const expected = Object.entries(httpMethods).flatMap(([service, methods]) => methods.map((method) => `${service}.${method}`));
  expect(Object.keys(cases).sort()).toEqual(expected.sort());
  expect(expected).toHaveLength(31);
  const files = {
    kv: "kv/KVService.ts", sql: "sql/SQLService.ts", duckdb: "duckdb/DuckDbService.ts",
    hooks: "hooks/HooksService.ts", namedKeys: "encryption/namedKeys.ts", quota: "quota/TinyCloudQuota.ts",
  };
  const actual = new Set<string>();
  for (const [service, file] of Object.entries(files)) {
    const source = ts.createSourceFile(file, readFileSync(resolve(import.meta.dir, file), "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText() === "usingResponse") {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
            const name = parent.name?.getText();
            // The two stream-attempt scopes have their own refused/late-body matrix.
            if (name && !(service === "hooks" && name === "attempt")) actual.add(`${service}.${name}`);
            break;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect([...actual].sort()).toEqual(expected.sort());
});

for (const [name, create] of Object.entries(cases)) {
  for (const scenario of ["nonOK", "abort"] as const) {
    test(`${name}: ${scenario} releases body and background lane`, async () => {
      const host = `https://${name.replace(/\./g, "-").toLowerCase()}-${scenario}-invariant.invalid`;
      const entered = deferred(); const release = deferred(); const siblingEntered = deferred();
      let cancellations = 0; let targetRequests = 0; let targetEntered = false;
      let requestSignal: AbortSignal | undefined;
      const owner = new ServiceContext({
        hosts: [host], session, priority: "background", invoke: () => ({}), invokeAny: () => ({}),
        fetch: async (url, init) => {
          if (name.startsWith("namedKeys.") && name !== "namedKeys.readNodeInfo" && url.endsWith("/info")) {
            return Response.json({ nodeId: "did:key:node", features: ["encryption-named-keys-v1"] });
          }
          targetRequests++; targetEntered = true; requestSignal = init?.signal; entered.resolve();
          // This transport intentionally ignores signal, including after session/sign-out abort.
          await release.promise;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i]));
              controller.close();
            },
            cancel() { cancellations++; },
          }), { status: scenario === "nonOK" ? 400 : 200 });
        },
      });
      const fetch: FetchFunction = async (url, init) => {
        const response = await owner.fetch(url, init);
        if (name.startsWith("namedKeys.") && name !== "namedKeys.readNodeInfo" && url.endsWith("/info")) return response;
        // An adapter can reject without draining its native body. The consumer still owns cleanup.
        for (const method of ["text", "json", "arrayBuffer", "blob"]) Object.defineProperty(response, method, {
          configurable: true,
          value: async () => { throw Object.assign(new Error(`${scenario} body failure`), { name: scenario === "abort" ? "AbortError" : "Error" }); },
        });
        return response;
      };
      const context: IServiceContext = {
        session, isAuthenticated: true, hosts: [host], abortSignal: owner.abortSignal, retryPolicy: owner.retryPolicy,
        fetch, invoke: () => ({}), invokeAny: () => ({}), getService: () => undefined,
        emit: () => {}, on: () => () => {},
      };
      const sibling = new ServiceContext({
        hosts: [host], priority: "background", invoke: () => ({}),
        fetch: async () => { siblingEntered.resolve(); return new Response("next"); },
      });
      const operation = create(context, owner, fetch, host);
      let next: Promise<string> | undefined;
      try {
        const pending = operation.run().then((value) => ({ value }), (error: unknown) => ({ error }));
        await Promise.race([entered.promise, pending.then(() => {
          if (!targetEntered) throw new Error(`${name} did not acquire its HTTP response`);
        })]);
        next = sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) }).then((response) => response.text());
        // Attach immediately so a failed invariant cannot produce an unhandled rejection.
        void next.catch(() => {});
        expect(targetRequests).toBe(1);
        if (scenario === "abort") {
          operation.abort();
          expect(requestSignal?.aborted).toBe(true);
        }
        release.resolve();
        await pending;
        expect(cancellations).toBe(1);
        expect(await next).toBe("next");
        await siblingEntered.promise;
      } finally {
        release.resolve(); operation.restore?.(); owner.retire(); sibling.retire();
        await next?.catch(() => {});
      }
    });
  }
}
