/**
 * Drift gate for `./replica-contract` (TC-858): node-sdk types its lazily
 * imported replica modules structurally so its build — DTS included — never
 * depends on replica's `dist`. Wherever replica IS built, this file pins the
 * copies to the real package, in both directions:
 *
 *  - compile time: the real modules must satisfy `ReplicaRuntime` and
 *    `SqliteRuntime`, and `KVService` must satisfy `KVSyncClient` (typechecked
 *    via `bun run typecheck:replica-contract`, which runs this file under
 *    `tsc --noEmit` with `moduleResolution: bundler` so the `/sqlite` subpath
 *    resolves);
 *  - run time: the test below asserts every member the adapter calls exists —
 *    a rename that would only ever surface inside `open`/`purge`/`sync` fails
 *    here first.
 */

import { describe, expect, test } from "bun:test";

import { KVService } from "@tinycloud/sdk-services";
import * as realReplica from "@tinycloud/replica";
import * as realSqlite from "@tinycloud/replica/sqlite";

import type {
  KVSyncClient,
  ReplicaRuntime,
  SqliteRuntime,
} from "./replica-contract";

// Compile-time half: assigning the real namespaces fails to typecheck the
// moment the declared contract and the real exports diverge. `kvSyncTransport`
// is only exercised where a `KVService` exists, so assignability of the
// transport's client is pinned here too.
const replicaRuntime: ReplicaRuntime = realReplica;
const parseUcanGrant: ReplicaRuntime["parseUcanGrant"] = realReplica.parseUcanGrant;
const sqliteRuntime: SqliteRuntime = realSqlite;
const kvClient: KVSyncClient = new KVService({});
void replicaRuntime;
void parseUcanGrant;
void sqliteRuntime;
void kvClient;

describe("replica contract: every member the adapter calls exists", () => {
  test("@tinycloud/replica exports", () => {
    expect(typeof realReplica.Replica).toBe("function");
    expect(typeof realReplica.ReplicaError).toBe("function");
    expect(typeof realReplica.isReplicaError).toBe("function");
    expect(typeof realReplica.parseUcanGrant).toBe("function");
    expect(typeof realReplica.assertGrantInstallable).toBe("function");
    expect(typeof realReplica.kvSyncTransport).toBe("function");
    for (const code of [
      "BUSY",
      "NOT_FOUND",
      "CLOSED",
      "CONFIG_MISMATCH",
      "SECRETS_OPT_IN_REQUIRED",
      "GRANT_NOT_COVERING",
      "RESET_REQUIRED",
    ] as const) {
      expect(typeof realReplica.ReplicaErrorCode[code]).toBe("string");
    }
  });

  test("@tinycloud/replica/sqlite exports", () => {
    expect(typeof realSqlite.SqliteReplicaStore.open).toBe("function");
    expect(typeof realSqlite.SqliteReplicaStore.inspect).toBe("function");
  });
});
