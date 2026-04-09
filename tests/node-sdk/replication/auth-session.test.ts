import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Session Auth", () => {
  test(
    "opens a short-lived replication session and requires Replication-Session for KV export",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("replication-session-kv");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");

        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const scope = `replication/session-auth/kv/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const putResult = await authority.kv.put(key, { createdAt: new Date().toISOString() });
        expect(putResult.ok).toBe(true);

        const unauthorized = await fetch(`${authorityNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            prefix: scope,
          }),
        });
        expect(unauthorized.status).toBe(401);

        const session = await authority.openReplicationSession({
          host: authorityNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });
        const transport = await openTransportSession(session);
        expect(session.host).toBe(authorityNode.url);
        expect(session.spaceId).toBe(authority.spaceId);
        expect(transport?.service).toBe("kv");
        expect(transport?.prefix).toBe(scope);
        expect(typeof transport?.sessionToken).toBe("string");
        expect((transport?.sessionToken.length ?? 0)).toBeGreaterThan(0);

        const authorized = await fetch(`${authorityNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": transport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            prefix: scope,
          }),
        });
        expect(authorized.status).toBe(200);

        const exportBody = await authorized.json() as {
          sequences: Array<{ events: Array<unknown> }>;
        };
        expect(exportBody.sequences.length).toBeGreaterThan(0);
        expect(exportBody.sequences[0]?.events.length ?? 0).toBeGreaterThan(0);
      } finally {
        await cluster.stop();
      }
    }
  );

  test(
    "opens a short-lived replication session and requires Replication-Session for SQL export",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("replication-session-sql");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");

        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const dbName = `replication_auth_${Date.now()}`;
        const tableName = `items_auth_${Date.now()}`;
        const sql = authority.sql.db(dbName);

        const createResult = await sql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL)`
        );
        expect(createResult.ok).toBe(true);

        const insertResult = await sql.execute(
          `INSERT INTO ${tableName} (id, name) VALUES (?, ?)`,
          ["item-1", "camera"]
        );
        expect(insertResult.ok).toBe(true);

        const unauthorized = await fetch(`${authorityNode.url}/replication/sql/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            dbName,
          }),
        });
        expect(unauthorized.status).toBe(401);

        const session = await authority.openReplicationSession({
          host: authorityNode.url,
          scope: {
            service: "sql",
            dbName,
          },
        });
        const transport = await openTransportSession(session);
        expect(session.host).toBe(authorityNode.url);
        expect(session.spaceId).toBe(authority.spaceId);
        expect(transport?.service).toBe("sql");
        expect(transport?.dbName).toBe(dbName);
        expect(typeof transport?.sessionToken).toBe("string");
        expect((transport?.sessionToken.length ?? 0)).toBeGreaterThan(0);

        const authorized = await fetch(`${authorityNode.url}/replication/sql/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": transport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            dbName,
          }),
        });
        expect(authorized.status).toBe(200);

        const exportBody = await authorized.json() as { snapshot: number[] };
        expect(exportBody.snapshot.length).toBeGreaterThan(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
