/**
 * Developer mode ON, one call per threaded ServiceContext accessor.
 *
 * Each row makes exactly one public call through a node restored from a real
 * signed session against the hermetic loopback node (real signatures, no
 * module mocking). Every row must record exactly one request-log event, labelled
 * with the service the accessor belongs to. Rows that cannot reach the network
 * fail here by design: a silent zero is the defect this table exists to catch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RequestEvent, RequestLogReader } from "@tinycloud/sdk-services";

import type { DelegatedAccess } from "./DelegatedAccess";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import {
  createHermeticEncryptedNode,
  type HermeticEncryptedNode,
} from "./test-support/hermetic-encrypted-node";

type Service = RequestEvent["service"];

interface Fixtures {
  node: TinyCloudNode;
  fixture: HermeticEncryptedNode;
  access: DelegatedAccess;
}

interface Row {
  /** Public accessor under test; names the ServiceContext site it reaches. */
  accessor: string;
  /** Expected request-log label for the single event this call records. */
  service: Service;
  call: (fx: Fixtures) => Promise<unknown>;
}

const PROBE_KEY = "request-log/probe";
const PROBE_SQL = "select 1";

// Deliberately absent: `node.spaces.list()` and `node.storage.status()` (granted path) send HTTP
// through SpaceService, which calls the raw graph fetch. No event is recorded for them, so they
// are reported as uncovered rather than pinned as zero here.

const ROWS: readonly Row[] = [
  { accessor: "node.kv", service: "kv", call: ({ node }) => node.kv.get(PROBE_KEY) },
  { accessor: "node.sql", service: "sql", call: ({ node }) => node.sql.execute(PROBE_SQL) },
  { accessor: "node.duckdb", service: "duckdb", call: ({ node }) => node.duckdb.execute(PROBE_SQL) },
  // Vault data travels over the KV wire (path `vault/...`); the request log labels by wire service.
  { accessor: "node.vault", service: "kv", call: ({ node }) => node.vault.list() },
  { accessor: "node.hooks", service: "hooks", call: ({ node }) => node.hooks.list() },
  {
    accessor: "node.kvForSpace(other)",
    service: "kv",
    call: ({ node, fixture }) => node.kvForSpace(fixture.applicationsSpaceId).get(PROBE_KEY),
  },
  {
    accessor: "node.sqlForSpace(other)",
    service: "sql",
    call: ({ node, fixture }) => node.sqlForSpace(fixture.applicationsSpaceId).execute(PROBE_SQL),
  },
  { accessor: "delegated.kv", service: "kv", call: ({ access }) => access.kv.get(PROBE_KEY) },
  { accessor: "delegated.sql", service: "sql", call: ({ access }) => access.sql.execute(PROBE_SQL) },
  { accessor: "delegated.duckdb", service: "duckdb", call: ({ access }) => access.duckdb.execute(PROBE_SQL) },
  { accessor: "delegated.hooks", service: "hooks", call: ({ access }) => access.hooks.list() },
];

async function eventsDuring(log: RequestLogReader, run: () => Promise<unknown>): Promise<RequestEvent[]> {
  const before = log.snapshot().length;
  // The count is the assertion; a rejected call is still a call that either did or did not reach the network.
  await run().catch(() => undefined);
  return log.snapshot().slice(before);
}

describe("TinyCloudNode request log, developer mode on, every threaded accessor", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    const fixture = await createHermeticEncryptedNode();
    const node = new TinyCloudNode({
      host: fixture.host,
      wasmBindings: new NodeWasmBindings(),
      requestLog: true,
    });
    await node.restoreSession(fixture.restorableSession);
    // Session-only useDelegation compares delegateDID with node.did (the PKH), while the
    // minted audience is the session key DID. Same override as TinyCloudNode.signOut.test.ts:
    // the restored session key still signs the invocations, so the call reaches the loopback.
    const minted = await fixture.mintDelegation();
    const access = await node.useDelegation({ ...minted, delegateDID: node.did });
    fx = { node, fixture, access };
  });

  afterAll(() => {
    fx?.fixture.stop();
  });

  for (const row of ROWS) {
    test(`${row.accessor}: one call records exactly one ${row.service} event`, async () => {
      const log = fx.node.requests;
      if (!log) throw new Error("developer mode on must expose the request log");

      const events = await eventsDuring(log, () => row.call(fx));

      expect(events).toHaveLength(1);
      expect(events[0]!.service).toBe(row.service);
    });
  }
});
