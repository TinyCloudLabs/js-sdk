import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { TinyCloudNode, type HookWebhookScope } from "@tinycloud/node-sdk";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import {
  type CapturedWebhookRequest,
  WebhookCallbackServer,
  findWebhookEvent,
  verifyWebhookSignature,
} from "./webhook-test-utils";
import { sleep, waitFor } from "./hooks-test-utils";

const PHASE4_STAMP = Date.now();
const SQL_DB_NAME = `phase4_sql_${PHASE4_STAMP}`;
const SQL_TABLE_NAME = `phase4_sql_items_${PHASE4_STAMP}`;
const DUCKDB_DB_NAME = `phase4_duckdb_${PHASE4_STAMP}`;
const DUCKDB_TABLE_NAME = `phase4_duckdb_items_${PHASE4_STAMP}`;

describe("Hooks webhooks integration", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("hooks-webhooks", TEST_KEY);
    await alice.signIn();
    await cleanupHooksByPrefix(alice, "phase3", ["kv"]);
    await cleanupHooksByPrefix(alice, "phase4", ["kv", "sql", "duckdb"]);
    await ensureSqlTable(alice);
    await ensureDuckDbTable(alice);
  });

  beforeEach(async () => {
    await cleanupHooksByPrefix(alice, "phase3", ["kv"]);
    await cleanupHooksByPrefix(alice, "phase4", ["kv", "sql", "duckdb"]);
  });

  afterAll(async () => {
    await cleanupHooksByPrefix(alice, "phase3", ["kv"]);
    await cleanupHooksByPrefix(alice, "phase4", ["kv", "sql", "duckdb"]);
    await dropSqlTable(alice);
    await dropDuckDbTable(alice);
    await alice?.signOut?.();
  });

  test("registers, lists, and unregisters KV webhooks over the live server", async () => {
    const server = await WebhookCallbackServer.start();
    const callbackPath = `/hooks/crud-${cryptoRandomSuffix()}`;
    const scope = {
      space: alice.spaceId!,
      service: "kv" as const,
      pathPrefix: "phase3/crud/",
      abilities: ["tinycloud.kv/put"],
    };
    const secret = randomBytes(32).toString("hex");

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        expect(createdResult.data.id).toBeTruthy();
        expect(createdResult.data.callbackUrl).toBe(
          `${server.url}${callbackPath}`,
        );
        expect(createdResult.data.space).toBe(scope.space);
        expect(createdResult.data.service).toBe(scope.service);

        const listResult = await alice.hooks.list(scope);
        expect(listResult.ok).toBe(true);
        if (!listResult.ok) {
          throw listResult.error;
        }

        expect(
          listResult.data.some((hook) => hook.id === createdResult.data.id),
        ).toBe(true);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }

      const listAfterDelete = await alice.hooks.list(scope);
      expect(listAfterDelete.ok).toBe(true);
      if (!listAfterDelete.ok) {
        throw listAfterDelete.error;
      }

      expect(
        listAfterDelete.data.some((hook) => hook.id === createdResult.data.id),
      ).toBe(false);
    } finally {
      await server.close();
    }
  }, 30000);

  test("delivers live KV webhook POSTs with a verifiable HMAC signature", async () => {
    const server = await WebhookCallbackServer.start();
    const callbackPath = `/hooks/delivery-${cryptoRandomSuffix()}`;
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "kv" as const,
      pathPrefix: "phase3/delivery/",
      abilities: ["tinycloud.kv/put"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        const key = `phase3/delivery/${cryptoRandomSuffix()}`;
        const value = `value-${cryptoRandomSuffix()}`;
        await putKvValue(alice, key, value);

        const requests = await waitForWebhookRequestsForPath(
          server,
          callbackPath,
          1,
          60000,
        );
        const request = requests[0];
        expect(request.method).toBe("POST");
        expect(request.path).toBe(callbackPath);

        const event = findWebhookEvent(request.jsonBody);
        expect(event).not.toBeNull();
        if (!event) {
          throw new Error("Webhook delivery did not include an event payload");
        }

        expect(event.space).toBe(scope.space);
        expect(event.service).toBe(scope.service);
        expect(event.ability).toBe("tinycloud.kv/put");
        expect(event.path).toBe(key);
        expect(typeof event.actor).toBe("string");
        expect(verifyWebhookSignature(request, secret)).toBe(true);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 90000);

  test("retries a failed webhook delivery before succeeding", async () => {
    let requestCount = 0;
    const callbackPath = `/hooks/retry-${cryptoRandomSuffix()}`;
    const server = await WebhookCallbackServer.start(() => {
      requestCount += 1;
      return {
        status: requestCount === 1 ? 500 : 200,
        body: requestCount === 1 ? { error: "transient" } : { ok: true },
      };
    });
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "kv" as const,
      pathPrefix: "phase3/retry/",
      abilities: ["tinycloud.kv/put"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        const key = `phase3/retry/${cryptoRandomSuffix()}`;
        await putKvValue(alice, key, `retry-${cryptoRandomSuffix()}`);

        const requests = await waitForWebhookRequestsForPath(
          server,
          callbackPath,
          2,
          120000,
        );
        const matching = requests.filter((request) => {
          const event = findWebhookEvent(request.jsonBody);
          return event?.path === key;
        });

        expect(matching.length).toBeGreaterThanOrEqual(2);
        expect(matching[0].rawBody).toBe(matching[1].rawBody);
        expect(verifyWebhookSignature(matching[0], secret)).toBe(true);
        expect(verifyWebhookSignature(matching[1], secret)).toBe(true);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 150000);

  test("stops retrying after repeated webhook failures", async () => {
    const callbackPath = `/hooks/dead-letter-${cryptoRandomSuffix()}`;
    const server = await WebhookCallbackServer.start(() => ({
      status: 500,
      body: { error: "permanent" },
    }));
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "kv" as const,
      pathPrefix: "phase3/dead-letter/",
      abilities: ["tinycloud.kv/put"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        await putKvValue(
          alice,
          `phase3/dead-letter/${cryptoRandomSuffix()}`,
          `dead-${cryptoRandomSuffix()}`,
        );

        await waitForWebhookRequestsForPath(server, callbackPath, 2, 180000);
        await server.waitForQuiet(2500, 120000);

        const requests = server.requests.filter(
          (request) => request.path === callbackPath,
        );
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests.length).toBeLessThanOrEqual(6);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 240000);

  test("delivers live SQL webhook POSTs with generic envelope fields", async () => {
    const server = await WebhookCallbackServer.start();
    const callbackPath = `/hooks/sql-delivery-${cryptoRandomSuffix()}`;
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "sql" as const,
      pathPrefix: `${SQL_DB_NAME}/${SQL_TABLE_NAME}`,
      abilities: ["tinycloud.sql/write"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        await putSqlValue(alice, `sql-${cryptoRandomSuffix()}`);

        const requests = await waitForWebhookRequestsForPath(
          server,
          callbackPath,
          1,
          90000,
        );
        const request = requests[0];
        const event = findWebhookEvent(request.jsonBody);
        expect(event).not.toBeNull();
        if (!event) {
          throw new Error("Webhook delivery did not include an event payload");
        }

        expect(event.space).toBe(scope.space);
        expect(event.service).toBe(scope.service);
        expect(event.ability).toBe("tinycloud.sql/write");
        expect(event.path).toBe(`${SQL_DB_NAME}/${SQL_TABLE_NAME}`);
        expect(typeof event.actor).toBe("string");
        expect(verifyWebhookSignature(request, secret)).toBe(true);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 90000);

  test("delivers live DuckDB webhook POSTs with generic envelope fields", async () => {
    const server = await WebhookCallbackServer.start();
    const callbackPath = `/hooks/duckdb-delivery-${cryptoRandomSuffix()}`;
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "duckdb" as const,
      pathPrefix: `${DUCKDB_DB_NAME}/${DUCKDB_TABLE_NAME}`,
      abilities: ["tinycloud.duckdb/write"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        await putDuckDbValue(alice, `duckdb-${cryptoRandomSuffix()}`);

        const requests = await waitForWebhookRequestsForPath(
          server,
          callbackPath,
          1,
          90000,
        );
        const request = requests[0];
        const event = findWebhookEvent(request.jsonBody);
        expect(event).not.toBeNull();
        if (!event) {
          throw new Error("Webhook delivery did not include an event payload");
        }

        expect(event.space).toBe(scope.space);
        expect(event.service).toBe(scope.service);
        expect(event.ability).toBe("tinycloud.duckdb/write");
        expect(event.path).toBe(`${DUCKDB_DB_NAME}/${DUCKDB_TABLE_NAME}`);
        expect(typeof event.actor).toBe("string");
        expect(verifyWebhookSignature(request, secret)).toBe(true);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 90000);

  test("does not deliver SQL webhooks when path prefix does not match", async () => {
    const server = await WebhookCallbackServer.start();
    const callbackPath = `/hooks/sql-filter-${cryptoRandomSuffix()}`;
    const secret = randomBytes(32).toString("hex");
    const scope = {
      space: alice.spaceId!,
      service: "sql" as const,
      pathPrefix: `${SQL_DB_NAME}/missing`,
      abilities: ["tinycloud.sql/write"],
    };

    try {
      const createdResult = await alice.hooks.register({
        ...scope,
        callbackUrl: `${server.url}${callbackPath}`,
        secret,
      });
      expect(createdResult.ok).toBe(true);
      if (!createdResult.ok) {
        throw createdResult.error;
      }

      try {
        await putSqlValue(alice, `sql-filter-${cryptoRandomSuffix()}`);
        await sleep(3000);

        const requests = server.requests.filter(
          (request) => request.path === callbackPath,
        );
        expect(requests.length).toBe(0);
      } finally {
        await unregisterWebhook(alice, createdResult.data.id, scope);
      }
    } finally {
      await server.close();
    }
  }, 45000);
});

async function putKvValue(node: TinyCloudNode, key: string, value: string) {
  const result = await node.kv.put(key, value);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function putSqlValue(node: TinyCloudNode, label: string): Promise<void> {
  const result = await node.sql
    .db(SQL_DB_NAME)
    .execute(
      `INSERT OR REPLACE INTO ${SQL_TABLE_NAME} (id, label) VALUES (${Date.now()}, '${label}')`,
    );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function putDuckDbValue(
  node: TinyCloudNode,
  label: string,
): Promise<void> {
  const result = await node.duckdb
    .db(DUCKDB_DB_NAME)
    .execute(
      `INSERT INTO ${DUCKDB_TABLE_NAME} (id, label) VALUES (${Date.now()}, '${label}')`,
    );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

function cryptoRandomSuffix(): string {
  return randomBytes(6).toString("hex");
}

async function unregisterWebhook(
  node: TinyCloudNode,
  id: string,
  target: HookWebhookScope,
): Promise<void> {
  const result = await node.hooks.unregister(id, { target });
  if (!result.ok) {
    throw result.error;
  }
}

async function waitForWebhookRequestsForPath(
  server: WebhookCallbackServer,
  path: string,
  count: number,
  timeoutMs: number,
): Promise<CapturedWebhookRequest[]> {
  await waitFor(
    () =>
      server.requests.filter((request) => request.path === path).length >=
      count,
    timeoutMs,
  );
  return server.requests.filter((request) => request.path === path);
}

async function ensureSqlTable(node: TinyCloudNode): Promise<void> {
  const result = await node.sql
    .db(SQL_DB_NAME)
    .execute(
      `CREATE TABLE IF NOT EXISTS ${SQL_TABLE_NAME} (id INTEGER PRIMARY KEY, label TEXT)`,
    );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function ensureDuckDbTable(node: TinyCloudNode): Promise<void> {
  const result = await node.duckdb
    .db(DUCKDB_DB_NAME)
    .execute(
      `CREATE TABLE IF NOT EXISTS ${DUCKDB_TABLE_NAME} (id INTEGER PRIMARY KEY, label VARCHAR)`,
    );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function dropSqlTable(node: TinyCloudNode): Promise<void> {
  const result = await node.sql
    .db(SQL_DB_NAME)
    .execute(`DROP TABLE IF EXISTS ${SQL_TABLE_NAME}`);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function dropDuckDbTable(node: TinyCloudNode): Promise<void> {
  const result = await node.duckdb
    .db(DUCKDB_DB_NAME)
    .execute(`DROP TABLE IF EXISTS ${DUCKDB_TABLE_NAME}`);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
}

async function cleanupHooksByPrefix(
  node: TinyCloudNode,
  prefix: string,
  services: HookWebhookScope["service"][],
): Promise<void> {
  if (!node.spaceId) {
    return;
  }

  for (const service of services) {
    const listed = await node.hooks.list({
      space: node.spaceId,
      service,
      pathPrefix: prefix,
    });
    if (!listed.ok) {
      throw listed.error;
    }

    for (const hook of listed.data) {
      const deleted = await node.hooks.unregister(hook.id, {
        target: {
          space: hook.space,
          service: hook.service,
          pathPrefix: hook.pathPrefix,
          abilities: hook.abilities,
        },
      });
      if (!deleted.ok) {
        throw deleted.error;
      }
    }
  }
}
