import { describe, expect, test } from "bun:test";
import type { HookWebhookRecord, HookWebhookRegistration } from "@tinycloud/sdk-services";
import { registerFeedNotify } from "./notify.js";

const SPACE = "tinycloud:pkh:eip155:1:0xabc:applications";
const RESOURCE = "xyz.tinycloud.tinychat/feed/agent/responses";
const URL_ = "https://grok.example/hook";
const KEY = "Bearer sk-DO-NOT-LEAK-0123456789";

function record(id: string, callbackUrl = URL_, headerNames: string[] = []): HookWebhookRecord {
  return { id, space: SPACE, service: "sql", pathPrefix: RESOURCE, callbackUrl, active: true, createdAt: "now", headerNames };
}

const CAP = { ok: false as const, error: { code: "NETWORK_ERROR", message: "register: 429 webhook subscription limit reached for space", service: "hooks", meta: { status: 429 } } };

/** A node with `existing` webhooks and room for `capacity` in total; every call is logged in order. */
function node(existing: HookWebhookRecord[], capacity: number, options: { failRetry?: boolean } = {}) {
  const log: string[] = [];
  const live = [...existing];
  let attempts = 0;
  return {
    log,
    live,
    hooks: {
      register: async (webhook: HookWebhookRegistration) => {
        attempts += 1;
        log.push("register");
        if (live.length >= capacity) return CAP;
        if (options.failRetry === true && attempts > 1) {
          return { ok: false as const, error: { code: "NETWORK_ERROR", message: "node unreachable", service: "hooks" } };
        }
        const created = record(`wh-new-${attempts}`, webhook.callbackUrl, Object.keys(webhook.headers ?? {}));
        live.push(created);
        return { ok: true as const, data: created };
      },
      list: async () => {
        log.push("list");
        return { ok: true as const, data: [...live] };
      },
      unregister: async (id: string) => {
        log.push(`unregister ${id}`);
        const at = live.findIndex((entry) => entry.id === id);
        if (at >= 0) live.splice(at, 1);
        return { ok: true as const, data: undefined };
      },
    },
  };
}

describe("registerFeedNotify replacement order", () => {
  test("with room, the new webhook exists before the old one is removed, and there is no gap to drain", async () => {
    const fake = node([record("wh-old")], 5);
    const receipt = await registerFeedNotify(fake.hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: {} });
    expect(fake.log).toEqual(["register", "list", "unregister wh-old"]);
    expect(receipt.replaced).toEqual(["wh-old"]);
    expect(receipt.missedWhileReplacing).toBeUndefined();
    expect(receipt.next).toBeUndefined();
  });

  test("at the node's webhook cap the earlier same-URL webhook goes first, and the receipt names the one drain that closes the gap", async () => {
    const fake = node([record("wh-old"), record("wh-other", "https://other.example/hook")], 2);
    const receipt = await registerFeedNotify(fake.hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: { Authorization: KEY } });
    expect(fake.log).toEqual(["register", "list", "unregister wh-old", "register"]);
    expect(fake.live.map((entry) => entry.id).sort()).toEqual(["wh-new-2", "wh-other"]);
    expect(receipt.id).toBe("wh-new-2");
    expect(receipt.replaced).toEqual(["wh-old"]);
    expect(receipt.missedWhileReplacing).toBe(true);
    expect(receipt.next).toBe("tinycloud feed watch --drain");
    expect(JSON.stringify(receipt)).not.toContain(KEY);
  });

  test("at the cap with nothing of ours to replace, the refusal is raised and nothing is removed", async () => {
    const fake = node([record("wh-a", "https://a.example/hook"), record("wh-b", "https://b.example/hook")], 2);
    await expect(registerFeedNotify(fake.hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: {} })).rejects.toThrow();
    expect(fake.log).toEqual(["register", "list"]);
    expect(fake.live).toHaveLength(2);
  });

  test("if the retry after making room fails, the error says what was removed and to drain, and shows no header value", async () => {
    const fake = node([record("wh-old")], 1, { failRetry: true });
    let message = "";
    await registerFeedNotify(fake.hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: { Authorization: KEY } })
      .catch((error: unknown) => { message = error instanceof Error ? error.message : ""; });
    expect(message).toContain("wh-old");
    expect(message).toContain("feed watch --drain");
    expect(message).not.toContain(KEY);
    expect(fake.live).toHaveLength(0);
  });
});
