import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IKVService } from "@tinycloud/node-sdk";
import { computeCid, encodeSealedInlineShareUrl, fromBase64Url, parseShortShareUrl, toBase64Url } from "@tinycloud/share-envelope";
import type { PublishedShare, SenderShareRecord } from "@tinycloud/share-sdk";
import { configureShareCommandServices, registerShareCommand } from "../commands/share.js";
import { createShareShortLinks, shortLinkTokenKey, type ShareShortLinks } from "./short-links.js";

const ORIGIN = "https://share.example";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";

/** An in-memory short-link service implementing the TC-1737 contract. */
function fakeService(options: { readonly createStatus?: number; readonly wrongCid?: boolean; readonly deleteStatus?: number; readonly getResponse?: () => Response } = {}) {
  const stored = new Map<string, { bytes: Uint8Array; token: string }>();
  const requests: { method: string; url: string; body?: string; authorization?: string }[] = [];
  let next = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}), ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }) });
    if (init?.redirect !== "error" || init.credentials !== "omit") throw new Error("short-link requests must refuse redirects and omit credentials");
    const id = url.slice(`${ORIGIN}/api/share-links/`.length);
    if (method === "POST" && url === `${ORIGIN}/api/share-links`) {
      if (options.createStatus !== undefined) return new Response(JSON.stringify({ error: "x" }), { status: options.createStatus });
      const body = JSON.parse(init!.body as string) as { ciphertext: string; expiresAt: string };
      const bytes = fromBase64Url(body.ciphertext);
      const newId = `${"a".repeat(25)}${"bcdefg"[next++]}`;
      const token = toBase64Url(new Uint8Array(32).fill(next));
      stored.set(newId, { bytes, token });
      const cid = options.wrongCid === true ? await computeCid(new Uint8Array([9])) : await computeCid(bytes);
      return new Response(JSON.stringify({ id: newId, cid, deleteToken: token }), { status: 201 });
    }
    if (method === "GET") {
      if (options.getResponse !== undefined) return options.getResponse();
      const entry = stored.get(id);
      return entry === undefined
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : new Response(entry.bytes.slice(), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (method === "DELETE") {
      if (options.deleteStatus !== undefined) return new Response(null, { status: options.deleteStatus });
      const entry = stored.get(id);
      if (entry === undefined || headers.get("authorization") !== `Bearer ${entry.token}`) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      stored.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { fetchFn, stored, requests };
}

function fakeKv(options: { readonly failPut?: boolean } = {}) {
  const values = new Map<string, Uint8Array>();
  const kv = {
    async get(key: string) {
      const value = values.get(key);
      return value === undefined ? { ok: false, error: { code: "KV_NOT_FOUND" } } : { ok: true, data: { data: value } };
    },
    async put(key: string, value: Uint8Array) {
      if (options.failPut === true) return { ok: false, error: { code: "PERMISSION_DENIED" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async delete(key: string) {
      values.delete(key);
      return { ok: true, data: {} };
    },
  } as unknown as IKVService;
  return { kv, values };
}

async function publishedShare(shareId = "share-1"): Promise<PublishedShare & { readonly key: string }> {
  const ciphertext = new Uint8Array(1500).map((_, index) => (index * 7) & 0xff);
  const key32 = new Uint8Array(32).fill(3);
  const url = await encodeSealedInlineShareUrl({ origin: ORIGIN, ciphertext, key32 });
  return {
    protocol: "tinycloud-share", version: 1, url,
    link: { kind: "policy", cid: "bafy-policy" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId, origin: ORIGIN,
      target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: SPACE },
      resource: { kind: "exact", path: `shares/${shareId}/note.md` }, actions: ["read"],
      expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
    },
    key: toBase64Url(key32),
  };
}

function recordFor(published: PublishedShare): SenderShareRecord {
  return {
    shareId: published.metadata.shareId,
    target: { origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: SPACE },
    resource: { kind: "exact", path: published.metadata.resource.path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
    registeredAt: "2026-10-21T00:00:00.000Z",
    expiresAt: published.metadata.expiresAt,
    link: published.url,
  };
}

describe("short links for addressed shares", () => {
  test("publishing sends only the sealed bytes and keeps the delete token in the owner's KV", async () => {
    const service = fakeService();
    const { kv, values } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const published = await publishedShare();

    const short = await links.shorten(published);

    const parsed = parseShortShareUrl(short, { expectedOrigin: ORIGIN });
    expect(short.length).toBeLessThan(200);
    expect(parsed.k).toBe(published.key);
    expect(service.requests).toHaveLength(1);
    const body = service.requests[0]!.body!;
    // The key and the link never reach the service.
    expect(body).not.toContain(published.key);
    expect(body).not.toContain("#");
    expect(JSON.parse(body)).toEqual({ ciphertext: expect.any(String), expiresAt: "2030-01-01T00:00:00.000Z" });
    const token = JSON.parse(new TextDecoder().decode(values.get(shortLinkTokenKey("share-1"))!)) as { id: string; deleteToken: string };
    expect(token.id).toBe(parsed.id);
    expect(service.stored.get(parsed.id)!.token).toBe(token.deleteToken);
  });

  test("a short link resolves to the original long link, and only from the trusted origin", async () => {
    const service = fakeService();
    const { kv } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const published = await publishedShare();
    const short = await links.shorten(published);

    expect(await links.resolve(short, ORIGIN)).toBe(published.url);
    // Any other link passes through untouched.
    expect(await links.resolve(published.url, ORIGIN)).toBe(published.url);
    const before = service.requests.length;
    await expect(links.resolve(short, "https://other.example")).rejects.toMatchObject({ code: "rejected" });
    expect(service.requests.length).toBe(before);
  });

  test("bytes that do not match the link's CID are refused, and a missing link reads as not found", async () => {
    const service = fakeService();
    const { kv } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const short = await links.shorten(await publishedShare());
    const id = parseShortShareUrl(short).id;
    service.stored.get(id)!.bytes[0] ^= 1;
    await expect(links.resolve(short, ORIGIN)).rejects.toMatchObject({ code: "invalid-response" });
    service.stored.delete(id);
    await expect(links.resolve(short, ORIGIN)).rejects.toMatchObject({ code: "not-found" });
  });

  test("a service that reports another CID gets no stored token", async () => {
    const service = fakeService({ wrongCid: true });
    const { kv, values } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    await expect(links.shorten(await publishedShare())).rejects.toMatchObject({ code: "invalid-response" });
    expect(values.size).toBe(0);
  });

  test("when the delete token cannot be kept, the stored bytes are deleted again", async () => {
    const service = fakeService();
    const { kv } = fakeKv({ failPut: true });
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    await expect(links.shorten(await publishedShare())).rejects.toMatchObject({ code: "token-store-failed" });
    expect(service.requests.map((request) => request.method)).toEqual(["POST", "DELETE"]);
    expect(service.stored.size).toBe(0);
  });

  test("revealing and discarding use the stored token", async () => {
    const service = fakeService();
    const { kv, values } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const published = await publishedShare();
    const short = await links.shorten(published);
    const record = recordFor(published);

    expect(await links.linkFor(record)).toBe(short);
    expect(await links.discard(record)).toBe("deleted");
    expect(service.stored.size).toBe(0);
    expect(values.size).toBe(0);
    // Nothing left: a second revoke has nothing to delete, and reveal falls back to the long link.
    expect(await links.discard(record)).toBe("none");
    expect(await links.linkFor(record)).toBeUndefined();
  });

  test("a failed delete keeps the token so it can be retried", async () => {
    const service = fakeService({ deleteStatus: 503 });
    const { kv, values } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const published = await publishedShare();
    await links.shorten(published);
    expect(await links.discard(recordFor(published))).toBe("failed");
    expect(values.size).toBe(1);
  });

  test("a shared file named short-link.json keeps its content apart from the token record", async () => {
    const service = fakeService();
    const { kv, values } = fakeKv();
    const links = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn });
    const published = await publishedShare("share-collide");
    // Where an addressed and a bearer share store a source file named short-link.json.
    const content = new TextEncoder().encode("user content");
    for (const path of ["shares/share-collide/short-link.json", "xyz.tinycloud.share/shares/share-collide/short-link.json"]) values.set(path, content);

    await links.shorten(published);

    expect(values.get("shares/share-collide/short-link.json")).toBe(content);
    expect(values.get("xyz.tinycloud.share/shares/share-collide/short-link.json")).toBe(content);
    // The key the Share web composer reads and writes too.
    expect(shortLinkTokenKey("share-collide")).toBe("xyz.tinycloud.share/shares/share-collide/.short-link.json");
    expect(values.has(shortLinkTokenKey("share-collide"))).toBe(true);
  });

  test("resolving refuses an oversized streamed body and a body that is not sealed bytes", async () => {
    const published = await publishedShare();
    const created = fakeService();
    const short = await createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn: created.fetchFn }).shorten(published);
    let pulled = 0;
    // A chunked body with no Content-Length that would grow without end.
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } });
    const oversized = createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn: fakeService({ getResponse: endless }).fetchFn });
    await expect(oversized.resolve(short, ORIGIN)).rejects.toMatchObject({ code: "too-large" });
    expect(pulled).toBeLessThan(10);

    const html = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    const wrongType = createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn: fakeService({ getResponse: html }).fetchFn });
    await expect(wrongType.resolve(short, ORIGIN)).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("tc share publish with short links", () => {
  afterEach(() => configureShareCommandServices({}));

  async function publish(args: readonly string[], links: ShareShortLinks) {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-short-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    const published = await publishedShare("share-cmd");
    const records = new Map<string, SenderShareRecord>();
    configureShareCommandServices({
      targetAdapter: { publish: async () => published },
      records: {
        async put(record) { records.set(record.shareId, record); },
        async get(shareId) { return records.get(shareId); },
        async list() { return [...records.values()]; },
        async delete(shareId) { records.delete(shareId); },
      },
      shortLinks: links,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const exitCode = process.exitCode;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "alice@example.com", ...args]);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const failed = process.exitCode;
    process.exitCode = exitCode;
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: failed, published, records };
  }

  test("prints the short link by default and keeps the long link in history", async () => {
    const service = fakeService();
    const { kv } = fakeKv();
    const result = await publish([], createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn }));
    const printed = result.stdout.trim();
    expect(parseShortShareUrl(printed, { expectedOrigin: ORIGIN }).k).toBe(result.published.key);
    expect(result.records.get("share-cmd")?.link).toBe(result.published.url);
    expect(result.stderr).toBe("");
  });

  test("--long-link prints the long link and creates nothing", async () => {
    const service = fakeService();
    const { kv } = fakeKv();
    const result = await publish(["--long-link"], createShareShortLinks({ kvForSpace: async () => kv, fetchFn: service.fetchFn }));
    expect(result.stdout).toBe(`${result.published.url}\n`);
    expect(service.requests).toEqual([]);
  });

  test("a failing service never fails the publish: long link, a warning, and shortLinkError in JSON", async () => {
    const human = await publish([], createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn: fakeService({ createStatus: 429 }).fetchFn }));
    expect(human.exitCode ?? 0).toBe(0);
    expect(human.stdout).toBe(`${human.published.url}\n`);
    expect(human.stderr).toContain("long");

    const json = await publish(["--json"], createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn: fakeService({ createStatus: 503 }).fetchFn }));
    expect(json.exitCode ?? 0).toBe(0);
    const output = JSON.parse(json.stdout) as { shortLinkError?: string };
    expect(output.shortLinkError).toBe("capacity");
    expect(json.stdout).not.toContain(json.published.key);
  });

  test("network-level failures and broken answers fall back too, and a stalled service is cut off", async () => {
    // Connection refused: what fetch throws when nothing listens.
    const refused = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) }); }) as unknown as typeof fetch;
    // Blackhole: never answers; ends only when the request's own signal aborts.
    const blackhole = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    // Answers 201 headers, then stalls the body forever.
    const stalledBody = ((_input: string | URL | Request, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); },
    }), { status: 201 }))) as unknown as typeof fetch;
    const serverError = (async () => new Response("<html>oops</html>", { status: 500 })) as unknown as typeof fetch;
    const garbage201 = (async () => new Response("not json", { status: 201 })) as unknown as typeof fetch;
    const cases: Array<[string, typeof fetch, string]> = [
      ["refused", refused, "unavailable"],
      ["blackhole", blackhole, "unavailable"],
      ["stalled body", stalledBody, "invalid-response"],
      ["HTTP 500", serverError, "unavailable"],
      ["garbage 201", garbage201, "invalid-response"],
    ];
    for (const [label, fetchFn, code] of cases) {
      const started = Date.now();
      const result = await publish(["--json"], createShareShortLinks({ kvForSpace: async () => fakeKv().kv, fetchFn, timeoutMs: 50 }));
      expect({ label, exit: result.exitCode ?? 0 }).toEqual({ label, exit: 0 });
      expect({ label, shortLinkError: (JSON.parse(result.stdout) as { shortLinkError?: string }).shortLinkError }).toEqual({ label, shortLinkError: code });
      expect(result.stderr).toContain("printing the long link instead");
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  test("a failing token-store write or revoke delete never fails the command", async () => {
    const service = fakeService();
    const human = await publish([], createShareShortLinks({ kvForSpace: async () => { throw new Error("kv unavailable"); }, fetchFn: service.fetchFn }));
    expect(human.exitCode ?? 0).toBe(0);
    expect(human.stdout).toBe(`${human.published.url}\n`);
    // The stored bytes were deleted again, since their delete token could not be kept.
    expect(service.stored.size).toBe(0);
    // Revoke: the record exists, but the DELETE cannot connect → "failed", and the token is kept for a retry.
    const { kv, values } = fakeKv();
    const published = await publishedShare("share-revoke-net");
    await createShareShortLinks({ kvForSpace: async () => kv, fetchFn: fakeService().fetchFn }).shorten(published);
    const offline = createShareShortLinks({ kvForSpace: async () => kv, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, timeoutMs: 50 });
    expect(await offline.discard(recordFor(published))).toBe("failed");
    expect(values.size).toBe(1);
  });
});
