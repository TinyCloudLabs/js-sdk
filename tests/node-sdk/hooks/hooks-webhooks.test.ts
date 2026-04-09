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
import { waitFor } from "./hooks-test-utils";

describe("Hooks webhooks integration", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("hooks-webhooks", TEST_KEY);
    await alice.signIn();
    await cleanupPhase3Hooks(alice);
  });

  beforeEach(async () => {
    await cleanupPhase3Hooks(alice);
  });

  afterAll(async () => {
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
});

async function putKvValue(node: TinyCloudNode, key: string, value: string) {
  const result = await node.kv.put(key, value);
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

async function cleanupPhase3Hooks(node: TinyCloudNode): Promise<void> {
  if (!node.spaceId) {
    return;
  }

  const listed = await node.hooks.list({
    space: node.spaceId,
    service: "kv",
    pathPrefix: "phase3",
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
