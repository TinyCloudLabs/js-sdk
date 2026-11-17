import { describe, expect, test } from "bun:test";
import type { HookWebhookRecord, HookWebhookRegistration } from "@tinycloud/sdk-services";
import type { WebhookHeaderReaders } from "../lib/webhook-headers.js";
import {
  listHookWebhooks, registerHookWebhook, removeHookWebhook, resolveHooksRegister,
} from "./webhooks.js";

const KEY = "Bearer wake-key-DO-NOT-LEAK";
const SPACE = "tinycloud:pkh:eip155:1:0xabc:applications";

function readers(parts: Partial<WebhookHeaderReaders> = {}): WebhookHeaderReaders {
  return { env: {}, readFile: async () => "", readStdin: async () => "", ...parts };
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a failure");
}

function record(id: string, extra: Record<string, unknown> = {}): HookWebhookRecord {
  return {
    id, space: SPACE, service: "sql", pathPrefix: "feed/responses.db", callbackUrl: "https://example.com/wake",
    headerNames: ["Authorization"], active: true, createdAt: "2026-11-17T00:00:00Z", ...extra,
  } as HookWebhookRecord;
}

function registrar(over: Partial<{ register: (w: HookWebhookRegistration) => Promise<unknown>; list: () => Promise<unknown> }> = {}) {
  const calls = { registered: undefined as HookWebhookRegistration | undefined, removed: [] as Array<{ id: string; options: unknown }> };
  return {
    calls,
    hooks: {
      register: async (webhook: HookWebhookRegistration) => {
        calls.registered = webhook;
        return { ok: true as const, data: record("wh-1", { callbackUrl: webhook.callbackUrl }) };
      },
      list: async () => ({ ok: true as const, data: [record("wh-1")] }),
      unregister: async (id: string, options?: unknown) => { calls.removed.push({ id, options }); return { ok: true as const, data: undefined }; },
      ...over,
    } as never,
  };
}

describe("tinycloud hooks register", () => {
  test("needs a known service and an https URL, and reads every header source before any request", async () => {
    expect(await messageOf(() => resolveHooksRegister({ service: "redis", url: "https://a.example/h" }))).toContain("--service");
    expect(await messageOf(() => resolveHooksRegister({ service: "sql" }))).toContain("--url");
    expect(await messageOf(() => resolveHooksRegister({ service: "sql", url: "http://a.example/h" }))).toContain("https");

    const input = await resolveHooksRegister(
      { service: "sql", url: "https://a.example/h", pathPrefix: "feed/responses.db", headerFile: ["Authorization=/run/key"], headerStdin: ["X-Routine"] },
      readers({ readFile: async () => `${KEY}\n`, readStdin: async () => "r-42\n" }),
    );
    expect(input).toMatchObject({
      service: "sql", pathPrefix: "feed/responses.db", callbackUrl: "https://a.example/h",
      headers: { Authorization: KEY, "X-Routine": "r-42" }, secretGenerated: true,
    });
    expect(input.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a reserved name or a line break is refused client-side, without the value", async () => {
    const reserved = await messageOf(() => resolveHooksRegister({ service: "sql", url: "https://a.example/h", header: [`Content-Type: ${KEY}`] }));
    expect(reserved).toContain("reserved");
    expect(reserved).not.toContain(KEY);
    const smuggled = await messageOf(() => resolveHooksRegister(
      { service: "sql", url: "https://a.example/h", headerEnv: ["X-A=V"] },
      readers({ env: { V: `${KEY}\r\nX-B: 1` } }),
    ));
    expect(smuggled).toContain('"X-A"');
    expect(smuggled).not.toContain(KEY);
  });

  test("the signing secret comes from the environment when named, and is then never echoed", async () => {
    const input = await resolveHooksRegister(
      { service: "kv", url: "https://a.example/h", secretEnv: "SIGNING" }, readers({ env: { SIGNING: "owner-chosen-secret-DO-NOT-LEAK" } }),
    );
    expect(input.secretGenerated).toBe(false);
    const { hooks } = registrar();
    const shown = await registerHookWebhook(hooks, SPACE, input);
    expect(JSON.stringify(shown)).not.toContain("owner-chosen-secret-DO-NOT-LEAK");
    expect(shown).not.toHaveProperty("secret");
    expect(await messageOf(() => resolveHooksRegister({ service: "kv", url: "https://a.example/h", secretEnv: "NOPE" }, readers())))
      .toContain("NOPE");
  });

  test("sends the headers once, shows names only, and shows a generated secret once", async () => {
    const { hooks, calls } = registrar();
    const input = await resolveHooksRegister(
      { service: "sql", url: "https://a.example/h", header: [`Authorization: ${KEY}`] }, readers(),
    );
    const shown = await registerHookWebhook(hooks, SPACE, input);
    expect(calls.registered).toMatchObject({ space: SPACE, service: "sql", callbackUrl: "https://a.example/h", headers: { Authorization: KEY } });
    expect(shown.headerNames).toEqual(["Authorization"]);
    expect(shown.secret).toBe(input.secret);
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });

  test("a webhook with no headers sends none, and a node that drops the headers has the webhook withdrawn", async () => {
    const plain = registrar();
    await registerHookWebhook(plain.hooks, SPACE, await resolveHooksRegister({ service: "kv", url: "https://a.example/h" }, readers()));
    expect(plain.calls.registered).not.toHaveProperty("headers");

    const dropping = registrar({ register: async (w) => ({ ok: true, data: record("wh-9", { callbackUrl: w.callbackUrl, headerNames: [] }) }) });
    const failure = await registerHookWebhook(
      dropping.hooks, SPACE,
      await resolveHooksRegister({ service: "sql", url: "https://a.example/h", header: [`Authorization: ${KEY}`] }, readers()),
    ).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("did not store the webhook headers");
    expect(failure?.message).not.toContain(KEY);
    expect(dropping.calls.removed.map((entry) => entry.id)).toEqual(["wh-9"]);
  });
});

describe("tinycloud hooks list and remove", () => {
  test("list shows header names, and nothing else a node returns, even a value it should not send", async () => {
    const { hooks } = registrar({
      list: async () => ({ ok: true, data: [record("wh-1", { headers: { Authorization: KEY }, encryptedHeaders: KEY, secret: "s3cret" })] }),
    });
    const listed = await listHookWebhooks(hooks, SPACE, { service: "sql" });
    expect(listed).toEqual([{
      id: "wh-1", space: SPACE, service: "sql", pathPrefix: "feed/responses.db", callbackUrl: "https://example.com/wake",
      headerNames: ["Authorization"], active: true, createdAt: "2026-11-17T00:00:00Z",
    }]);
    expect(JSON.stringify(listed)).not.toContain(KEY);
    expect(JSON.stringify(listed)).not.toContain("s3cret");
  });

  test("a record from an older node has no header names, shown as an empty list", async () => {
    const { hooks } = registrar({ list: async () => ({ ok: true, data: [record("wh-1", { headerNames: undefined })] }) });
    expect((await listHookWebhooks(hooks, SPACE, {}))[0]?.headerNames).toEqual([]);
  });

  test("a service filter is checked, and a node failure is a CLI error", async () => {
    const { hooks } = registrar({ list: async () => ({ ok: false, error: { code: "AUTH_REQUIRED", message: "no register ability", service: "hooks" } }) });
    expect(await messageOf(() => listHookWebhooks(hooks, SPACE, { service: "redis" }))).toContain("--service");
    expect(await messageOf(() => listHookWebhooks(hooks, SPACE, {}))).toContain("no register ability");
  });

  test("remove targets the webhook's scope when given, and needs a service for a prefix", async () => {
    const { hooks, calls } = registrar();
    expect(await removeHookWebhook(hooks, SPACE, "wh-1", { service: "sql", pathPrefix: "feed/responses.db" })).toEqual({ removed: "wh-1" });
    expect(await removeHookWebhook(hooks, SPACE, "wh-2", {})).toEqual({ removed: "wh-2" });
    expect(calls.removed).toEqual([
      { id: "wh-1", options: { target: { space: SPACE, service: "sql", pathPrefix: "feed/responses.db" } } },
      { id: "wh-2", options: {} },
    ]);
    expect(await messageOf(() => removeHookWebhook(hooks, SPACE, "wh-3", { pathPrefix: "x" }))).toContain("--service");
  });
});
