import { describe, expect, test } from "bun:test";
import type { HookWebhookRecord, HookWebhookRegistration } from "@tinycloud/sdk-services";
import { registerFeedNotify, resolveFeedNotify } from "./notify.js";
import type { WebhookHeaderReaders } from "../lib/webhook-headers.js";

const KEY = "Bearer routine-key-DO-NOT-LEAK";

function readers(parts: Partial<WebhookHeaderReaders> = {}): WebhookHeaderReaders {
  return {
    env: {},
    readFile: async () => { throw new Error(`ENOENT: ${KEY}`); },
    readStdin: async () => "",
    ...parts,
  };
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a failure");
}

describe("feed connect --notify-*", () => {
  test("no notify flags means no webhook", async () => {
    expect(await resolveFeedNotify({})).toBeUndefined();
  });

  test("header flags without a URL are refused", async () => {
    expect(await messageOf(() => resolveFeedNotify({ notifyHeader: [`Authorization: ${KEY}`] }))).toContain("--notify-url");
    expect(await messageOf(() => resolveFeedNotify({ notifyHeaderFile: ["Authorization=/k"] }))).toContain("--notify-url");
  });

  test("a header comes from a flag, the environment, a file or stdin, with the value trimmed", async () => {
    const notify = await resolveFeedNotify(
      {
        notifyUrl: "https://grok.example/hook", notifyHeader: [`Authorization: ${KEY}`], notifyHeaderEnv: ["X-Routine=ROUTINE_ID"],
        notifyHeaderFile: ["X-File=/run/secret"], notifyHeaderStdin: ["X-Stdin"],
      },
      readers({
        env: { ROUTINE_ID: " r-42 " },
        readFile: async (path) => (path === "/run/secret" ? "from-file\n" : ""),
        readStdin: async () => "from-stdin\r\n",
      }),
    );
    expect(notify).toEqual({
      callbackUrl: "https://grok.example/hook",
      headers: { Authorization: KEY, "X-Routine": "r-42", "X-File": "from-file", "X-Stdin": "from-stdin" },
    });
  });

  test("the first colon splits the name, so a value may contain colons", async () => {
    expect((await resolveFeedNotify({ notifyUrl: "https://a.example/h", notifyHeader: ["X-Url: https://b.example:8443/x"] }))?.headers)
      .toEqual({ "X-Url": "https://b.example:8443/x" });
  });

  test.each(["Host", "Content-Length", "Cookie", "X-TinyCloud-Signature", "Proxy-Authorization"])(
    "reserved header %s is refused before anything is provisioned, without its value",
    async (name) => {
      const message = await messageOf(() => resolveFeedNotify({ notifyUrl: "https://a.example/h", notifyHeader: [`${name}: ${KEY}`] }));
      expect(message).toContain("reserved");
      expect(message).not.toContain(KEY);
    },
  );

  test.each([
    ["a flag", { notifyHeader: ["X-A: line\r\nX-B: smuggled"] }, readers()],
    ["the environment", { notifyHeaderEnv: ["X-A=V"] }, readers({ env: { V: "line\nX-B: smuggled" } })],
    ["a file", { notifyHeaderFile: ["X-A=/f"] }, readers({ readFile: async () => "line\r\nX-B: smuggled" })],
    ["stdin", { notifyHeaderStdin: ["X-A"] }, readers({ readStdin: async () => "a\nb" })],
  ])("a line break in a value from %s is refused, and the error does not quote it", async (_source, flags, io) => {
    const message = await messageOf(() => resolveFeedNotify({ notifyUrl: "https://a.example/h", ...flags }, io));
    expect(message).toContain('"X-A"');
    expect(message).not.toContain("smuggled");
  });

  test("an unset environment variable names the variable, never a value", async () => {
    const message = await messageOf(() => resolveFeedNotify({ notifyUrl: "https://a.example/h", notifyHeaderEnv: ["Authorization=GROK_KEY"] }, readers()));
    expect(message).toContain("GROK_KEY");
  });

  test("an unreadable or empty file, and empty stdin, are refused; the reader's own error is never quoted", async () => {
    const unreadable = await messageOf(() => resolveFeedNotify({ notifyUrl: "https://a.example/h", notifyHeaderFile: ["Authorization=/nope"] }, readers()));
    expect(unreadable).toContain('"Authorization"');
    expect(unreadable).not.toContain(KEY);
    expect(await messageOf(() => resolveFeedNotify(
      { notifyUrl: "https://a.example/h", notifyHeaderFile: ["Authorization=/e"] }, readers({ readFile: async () => " \n" }),
    ))).toContain("empty");
    expect(await messageOf(() => resolveFeedNotify({ notifyUrl: "https://a.example/h", notifyHeaderStdin: ["Authorization"] }, readers())))
      .toContain("Nothing was piped");
  });

  test("stdin holds one value, so it can feed one header", async () => {
    expect(await messageOf(() => resolveFeedNotify(
      { notifyUrl: "https://a.example/h", notifyHeaderStdin: ["X-A", "X-B"] }, readers({ readStdin: async () => "v" }),
    ))).toContain("once");
  });

  test("a URL must be https and carry no credentials", async () => {
    expect(await messageOf(() => resolveFeedNotify({ notifyUrl: "http://a.example/h" }))).toContain("https");
    expect(await messageOf(() => resolveFeedNotify({ notifyUrl: "not a url" }))).toContain("https");
    const message = await messageOf(() => resolveFeedNotify({ notifyUrl: "https://user:pw-DO-NOT-LEAK@a.example/h" }));
    expect(message).toContain("credentials");
    expect(message).not.toContain("pw-DO-NOT-LEAK");
  });

  test("the same header twice, from any two sources, is refused", async () => {
    expect(await messageOf(() => resolveFeedNotify(
      { notifyUrl: "https://a.example/h", notifyHeader: ["X-A: 1"], notifyHeaderEnv: ["x-a=A"] }, readers({ env: { A: "2" } }),
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
    expect(failure?.message).toContain("did not store the webhook headers");
    expect(failure?.message).not.toContain(KEY);
    expect(calls.removed).toEqual(["wh-new"]);
  });
});
