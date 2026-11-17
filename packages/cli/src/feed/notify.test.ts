import { describe, expect, test } from "bun:test";
import type { HookWebhookRecord, HookWebhookRegistration } from "@tinycloud/sdk-services";
import { parseFeedNotify, registerFeedNotify } from "./notify.js";

const KEY = "Bearer routine-key-DO-NOT-LEAK";

function messageOf(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a failure");
}

describe("feed connect --notify-*", () => {
  test("no notify flags means no webhook", () => {
    expect(parseFeedNotify({})).toBeUndefined();
  });

  test("header flags without a URL are refused", () => {
    expect(messageOf(() => parseFeedNotify({ notifyHeader: [`Authorization: ${KEY}`] }))).toContain("--notify-url");
  });

  test("a header comes from the command line or the environment, with the value trimmed", () => {
    const notify = parseFeedNotify(
      { notifyUrl: "https://grok.example/hook", notifyHeader: [`Authorization: ${KEY}`], notifyHeaderEnv: ["X-Routine=ROUTINE_ID"] },
      { ROUTINE_ID: " r-42 " },
    );
    expect(notify).toEqual({
      callbackUrl: "https://grok.example/hook",
      headers: { Authorization: KEY, "X-Routine": "r-42" },
    });
  });

  test("the first colon splits the name, so a value may contain colons", () => {
    expect(parseFeedNotify({ notifyUrl: "https://a.example/h", notifyHeader: ["X-Url: https://b.example:8443/x"] })?.headers)
      .toEqual({ "X-Url": "https://b.example:8443/x" });
  });

  test.each(["Host", "Content-Length", "Cookie", "X-TinyCloud-Signature"])(
    "reserved header %s is refused before anything is provisioned, without its value",
    (name) => {
      const message = messageOf(() => parseFeedNotify({ notifyUrl: "https://a.example/h", notifyHeader: [`${name}: ${KEY}`] }));
      expect(message).toContain("reserved");
      expect(message).not.toContain(KEY);
    },
  );

  test("an unset environment variable names the variable, never a value", () => {
    const message = messageOf(() => parseFeedNotify({ notifyUrl: "https://a.example/h", notifyHeaderEnv: ["Authorization=GROK_KEY"] }, {}));
    expect(message).toContain("GROK_KEY");
  });

  test("a URL must be https and carry no credentials", () => {
    expect(messageOf(() => parseFeedNotify({ notifyUrl: "http://a.example/h" }))).toContain("https");
    expect(messageOf(() => parseFeedNotify({ notifyUrl: "not a url" }))).toContain("https");
    const message = messageOf(() => parseFeedNotify({ notifyUrl: "https://user:pw-DO-NOT-LEAK@a.example/h" }));
    expect(message).toContain("credentials");
    expect(message).not.toContain("pw-DO-NOT-LEAK");
  });

  test("the same header twice, in either flag, is refused", () => {
    expect(messageOf(() => parseFeedNotify(
      { notifyUrl: "https://a.example/h", notifyHeader: ["X-A: 1"], notifyHeaderEnv: ["x-a=A"] }, { A: "2" },
    ))).toContain("more than once");
  });
});

const SPACE = "tinycloud:pkh:eip155:1:0xabc:applications";
const RESOURCE = "xyz.tinycloud.tinychat/feed/agent/responses";
const URL_ = "https://grok.example/hook";

function record(id: string, callbackUrl = URL_) {
  return { id, space: SPACE, service: "sql" as const, pathPrefix: RESOURCE, callbackUrl, active: true, createdAt: "now" };
}

function registrar(existing: HookWebhookRecord[] = [], failRemoval: string[] = []) {
  const calls = { registered: undefined as HookWebhookRegistration | undefined, removed: [] as string[] };
  return {
    calls,
    hooks: {
      register: async (webhook: HookWebhookRegistration) => {
        calls.registered = webhook;
        return { ok: true as const, data: { ...record("wh-new", webhook.callbackUrl), headerNames: ["Authorization"] } };
      },
      list: async () => ({ ok: true as const, data: [...existing, record("wh-new")] }),
      unregister: async (id: string) => {
        if (failRemoval.includes(id)) return { ok: false as const, error: { code: "NETWORK_ERROR", message: "x", service: "hooks" } };
        calls.removed.push(id);
        return { ok: true as const, data: undefined };
      },
    },
  };
}

describe("registerFeedNotify", () => {
  test("registers one webhook on the response database and returns names plus a one-time secret, never header values", async () => {
    const { hooks, calls } = registrar();
    const receipt = await registerFeedNotify(hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: { Authorization: KEY } });

    expect(calls.registered).toMatchObject({
      space: SPACE, service: "sql", pathPrefix: RESOURCE, callbackUrl: URL_, headers: { Authorization: KEY },
    });
    expect(calls.registered?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).toEqual({ id: "wh-new", callbackUrl: URL_, headerNames: ["Authorization"], secret: calls.registered!.secret, replaced: [] });
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    expect(calls.removed).toEqual([]);
  });

  test("a re-run replaces an earlier webhook for the same URL on this feed and leaves other URLs alone", async () => {
    const { hooks, calls } = registrar([record("wh-old"), record("wh-other", "https://other.example/hook")]);
    const receipt = await registerFeedNotify(hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: {} });
    expect(calls.removed).toEqual(["wh-old"]);
    expect(receipt.replaced).toEqual(["wh-old"]);
    expect(receipt.staleRemaining).toBeUndefined();
  });

  test("an earlier webhook that cannot be removed is reported, not hidden", async () => {
    const { hooks } = registrar([record("wh-old")], ["wh-old"]);
    const receipt = await registerFeedNotify(hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: {} });
    expect(receipt.replaced).toEqual([]);
    expect(receipt.staleRemaining).toBe(1);
  });

  test("a node refusal is raised as a CLI error and nothing is removed", async () => {
    const { hooks, calls } = registrar([record("wh-old")]);
    hooks.register = async () => ({ ok: false as never, error: { code: "INVALID_INPUT", message: "callback not allowed", service: "hooks" } } as never);
    await expect(registerFeedNotify(hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: {} })).rejects.toThrow("callback not allowed");
    expect(calls.removed).toEqual([]);
  });

  test("a node that does not confirm the header names is treated as unsupported: the webhook is withdrawn and the error carries no value", async () => {
    const { hooks, calls } = registrar();
    hooks.register = async (webhook: HookWebhookRegistration) => ({ ok: true as const, data: record("wh-new", webhook.callbackUrl) });
    const failure = await registerFeedNotify(hooks, SPACE, RESOURCE, { callbackUrl: URL_, headers: { Authorization: KEY } })
      .then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("did not store the notify headers");
    expect(failure?.message).not.toContain(KEY);
    expect(calls.removed).toEqual(["wh-new"]);
  });
});
