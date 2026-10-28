import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBase64Url, generateKey, seal, toBase64Url } from "@tinycloud/share-envelope";
import {
  buildFullLink,
  parseLink,
  prepareLinkRecord,
  signerFromSeed,
  validateLinkDeleteRequest,
  validateLinkHeader,
  verifyDelete,
  verifyHeader,
  type LinkSigner,
} from "@tinycloud/share-envelope/links";
import { ADDRESSED_SHARE_TOO_LARGE_MESSAGE, SharePublishError, type PublishedShare, type SenderShareRecord } from "@tinycloud/share-sdk";
import { SharePublishAuthorityError } from "./errors.js";
import { ShareDeliveryRefusedError } from "@tinycloud/sdk-core";
import vectors from "../../../share-envelope/test/links-api-vectors.json";
import { configureShareCommandServices, registerShareCommand, type ShareCommandServices } from "../commands/share.js";
import { runShareCaptured } from "../commands/share.integration-harness.js";
import { LINK_EXPIRY_WARNING, LINK_EXPIRY_WARNING_URL, createShareLinks, linkFormForLifetime, shortLinkId } from "./short-links.js";
import { buildShortLink } from "@tinycloud/share-envelope/links";

const ORIGIN = "https://share.example";
const API = "https://api.tinycloud.xyz";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const signer: LinkSigner = signerFromSeed(SEED);
const emailDescriptorFixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as {
  vectors: { name: string; descriptor: unknown }[];
};
const emailDescriptor = emailDescriptorFixture.vectors.find((vector) => vector.name === "email")?.descriptor;
if (emailDescriptor === undefined) throw new Error("golden email descriptor is missing");

interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
  readonly headers: string;
}

/** An in-memory links API: it verifies every signature the way the service does and stores records by id. */
function stubApi(options: { readonly createStatus?: number; readonly deleteStatus?: number } = {}) {
  const stored = new Map<string, { issuer: string; expiresAt: string }>();
  const requests: Request[] = [];
  let next = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method: init?.method ?? "GET", url, body, headers: JSON.stringify(init?.headers ?? {}) });
    if (init?.redirect !== "error" || init.credentials !== "omit") throw new Error("links requests must refuse redirects and omit credentials");
    if (url === `${API}/v1/links`) {
      if (options.createStatus !== undefined) return new Response(JSON.stringify({ error: "rate_limited" }), { status: options.createStatus });
      const parsed = JSON.parse(body!) as { header: unknown; signature: unknown };
      const header = validateLinkHeader(parsed.header, { mode: "signed", audience: API });
      if (!verifyHeader(header, parsed.signature)) return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
      const id = `${"a".repeat(25)}${"bcdefg"[next++]}`;
      stored.set(id, { issuer: header.issuer, expiresAt: header.expiresAt });
      return new Response(JSON.stringify({ id, expiresAt: header.expiresAt }), { status: 201 });
    }
    const deleted = /^https:\/\/api\.tinycloud\.xyz\/v1\/links\/([a-z2-7]{26})\/delete$/.exec(url);
    if (deleted !== null) {
      if (options.deleteStatus !== undefined) return new Response(null, { status: options.deleteStatus });
      const parsed = JSON.parse(body!) as { request: unknown; signature: unknown };
      const request = validateLinkDeleteRequest(parsed.request, { audience: API });
      if (!verifyDelete(request, parsed.signature)) return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
      const entry = stored.get(request.id);
      if (request.id !== deleted[1] || entry === undefined || entry.issuer !== request.issuer) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      stored.delete(request.id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { fetchFn, stored, requests };
}

interface Share extends PublishedShare {
  readonly key: string;
}

/** A published addressed share whose life is `lifetimeSeconds` from now, with real sealed delivery material and its full link. */
async function publishedShare(shareId = "share-1", lifetimeSeconds = 7 * 86_400): Promise<Share> {
  const key = generateKey();
  const sealed = await seal(new TextEncoder().encode(JSON.stringify({ shareId, filler: "x".repeat(1500), signature: { signerDid: signer.did } })), key);
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + lifetimeSeconds * 1000);
  const { record } = await prepareLinkRecord({ type: "share", sealed: { blob: sealed.blob, key }, issuerKey: signer, apiOrigin: API, expiresAt, enforceServiceLife: false });
  const url = buildFullLink({ origin: ORIGIN, key, record });
  const published = {
    protocol: "tinycloud-share", version: 1, url,
    link: { kind: "policy", cid: sealed.cid },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId, origin: ORIGIN,
      target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: SPACE },
      resource: { kind: "exact", path: `shares/${shareId}/note.md` }, actions: ["read"],
      expiresAt: expiresAt.toISOString(), display: { filename: "note.md" },
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
    },
    deliveryMaterial: { envelope: {}, shareCid: sealed.cid, sealedEnvelope: toBase64Url(sealed.blob), envelopeKey: toBase64Url(key) },
    key: toBase64Url(key),
  } satisfies Share;
  return published;
}

describe("link choice", () => {
  test("follows the contract's linkChoice vectors", () => {
    for (const vector of vectors.linkChoice) {
      const choice = linkFormForLifetime(vector.shareLifetimeSeconds);
      expect({ seconds: vector.shareLifetimeSeconds, form: choice.form as string, warning: choice.warning }).toEqual({
        seconds: vector.shareLifetimeSeconds, form: vector.expect.form, warning: vector.expect.warning,
      });
      if (vector.expect.warning) expect(LINK_EXPIRY_WARNING).toContain(vector.expect.warningUrl as string);
    }
    expect(LINK_EXPIRY_WARNING_URL).toBe(vectors.constants.warningUrl);
  });
});

describe("share links", () => {
  test("a short link is created through the API, signed by the publishing key, and the key stays in the fragment", async () => {
    const api = stubApi();
    const links = createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn });
    const published = await publishedShare();

    const shown = await links.show(published, { fullLink: false });

    expect(shown.short).toBe(true);
    expect(shown.notice).toBeUndefined();
    const parsed = parseLink(shown.url, { trustedOrigins: [ORIGIN] });
    expect(parsed.form).toBe("short");
    expect(toBase64Url(parsed.key)).toBe(published.key);
    expect(shown.url.startsWith(`${ORIGIN}/s/`)).toBe(true);
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(`${API}/v1/links`);
    // The key (and the fragment) is in no request: not the URL, the headers or the body.
    for (const part of [request!.url, request!.headers, request!.body!]) {
      expect(part).not.toContain(published.key);
      expect(part).not.toContain("#v=4");
    }
    const sent = JSON.parse(request!.body!) as { header: { issuer: string; expiresAt: string; type: string }; body: string };
    expect(sent.header.issuer).toBe(signer.did);
    expect(sent.header.type).toBe("share");
    expect(sent.header.expiresAt).toBe(published.metadata.expiresAt);
    expect(sent.body).toBe(published.deliveryMaterial!.sealedEnvelope);
    expect([...api.stored.values()][0]!.issuer).toBe(signer.did);
  });

  test("a share under two minutes gets the full link, with no warning and no request", async () => {
    const api = stubApi();
    const published = await publishedShare("share-short-life", 90);
    const shown = await createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }).show(published, { fullLink: false });
    expect(shown).toEqual({ url: published.url, short: false });
    expect(api.requests).toEqual([]);
  });

  test("a share over 30 days gets the full link and the contract's warning, with no request", async () => {
    const api = stubApi();
    const published = await publishedShare("share-long-life", 30 * 86_400 + 60);
    const shown = await createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }).show(published, { fullLink: false });
    expect(shown.url).toBe(published.url);
    expect(shown.short).toBe(false);
    expect(shown.notice).toBe(LINK_EXPIRY_WARNING);
    expect(shown.notice).toContain("https://tinycloud.xyz/delegations?from=link-expiry");
    expect(api.requests).toEqual([]);
  });

  test("a bearer share keeps its own link and makes no request", async () => {
    const api = stubApi();
    const published = { ...(await publishedShare("share-bearer")), link: { kind: "native" as const, cid: "bafy-native" } };
    const shown = await createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }).show(published, { fullLink: false });
    expect(shown).toEqual({ url: published.url, short: false });
    expect(api.requests).toEqual([]);
  });

  test("unlink deletes with a request signed by the same key; a second delete finds nothing", async () => {
    const api = stubApi();
    const links = createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn });
    const shown = await links.show(await publishedShare(), { fullLink: false });
    const id = shortLinkId(shown.url)!;
    expect(api.stored.has(id)).toBe(true);

    expect(await links.unlink(id)).toBe("deleted");
    expect(api.stored.size).toBe(0);
    expect(await links.unlink(id)).toBe("absent");
    const deletes = api.requests.filter((request) => request.url.endsWith("/delete"));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.url).toBe(`${API}/v1/links/${id}/delete`);
    expect(deletes[0]!.headers).not.toContain("authorization");
    expect(JSON.parse(deletes[0]!.body!).request.issuer).toBe(signer.did);
    // A key that did not issue the link learns nothing: the same absent answer.
    const stranger = createShareLinks({ signer: async () => signerFromSeed(new Uint8Array(32).fill(9)), fetchFn: api.fetchFn });
    const again = await links.show(await publishedShare("share-2"), { fullLink: false });
    expect(await stranger.unlink(shortLinkId(again.url)!)).toBe("absent");
    expect(api.stored.size).toBe(1);
  });

  test("shortLinkId reads a short link and nothing else", async () => {
    const published = await publishedShare();
    expect(shortLinkId(published.url)).toBeUndefined();
    expect(shortLinkId(undefined)).toBeUndefined();
    expect(shortLinkId(`${ORIGIN}/s/inline#v=2&p=abc`)).toBeUndefined();
    const shown = await createShareLinks({ signer: async () => signer, fetchFn: stubApi().fetchFn }).show(published, { fullLink: false });
    expect(shortLinkId(shown.url)).toMatch(/^[a-z2-7]{26}$/);
  });

  test("the create request is exactly the signed record, and the short link stays short", async () => {
    const api = stubApi();
    const published = await publishedShare();
    const now = new Date();
    const shown = await createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }).show(published, { fullLink: false, now });
    expect(shown.url.length).toBeLessThan(200);
    const body: unknown = JSON.parse(api.requests[0]!.body!);
    expect(body).toEqual({
      header: {
        version: 1, type: "share", issuer: signer.did, audience: API, issuedAt: now.toISOString(), expiresAt: published.metadata.expiresAt,
        size: fromBase64Url(published.deliveryMaterial!.sealedEnvelope).length, bodyCid: published.link.cid,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
      signature: { algorithm: "Ed25519", value: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) },
      body: published.deliveryMaterial!.sealedEnvelope,
    });
  });
});

describe("tc share with links", () => {
  afterEach(() => configureShareCommandServices({}));

  async function run(args: readonly string[], services: ShareCommandServices) {
    configureShareCommandServices(services);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const exitCode = process.exitCode;
    const originalExit = process.exit;
    let exitedWith: number | undefined;
    process.exitCode = undefined;
    process.exit = ((code?: number) => { exitedWith = code; }) as typeof process.exit;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", ...args]);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      process.exit = originalExit;
    }
    const failed = exitedWith ?? process.exitCode;
    process.exitCode = exitCode;
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: failed };
  }

  function memoryRecords() {
    const records = new Map<string, SenderShareRecord>();
    return {
      records,
      storage: {
        async put(record: SenderShareRecord) { records.set(record.shareId, record); },
        async get(shareId: string) { return records.get(shareId); },
        async list() { return [...records.values()]; },
        async delete(shareId: string) { records.delete(shareId); },
      },
    };
  }

  async function publish(args: readonly string[], input: { readonly fetchFn: typeof fetch; readonly lifetimeSeconds?: number; readonly timeoutMs?: number; readonly invitations?: boolean; readonly productionShape?: boolean; readonly rootJson?: boolean; readonly omitMaterial?: boolean }) {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-links-"));
    const file = join(directory, "note.md");
    const descriptorPath = join(directory, "email-descriptor.json");
    await writeFile(file, "# note\n");
    await writeFile(descriptorPath, JSON.stringify(emailDescriptor));
    const published = await publishedShare("share-cmd", input.lifetimeSeconds);
    if (input.omitMaterial === true) delete (published as { deliveryMaterial?: PublishedShare["deliveryMaterial"] }).deliveryMaterial;
    if (input.productionShape === true) {
      Object.defineProperty(published, "deliveryMaterial", { value: published.deliveryMaterial, enumerable: false });
      Object.defineProperty(published, "url", { value: published.url, enumerable: false });
    }
    const { records, storage } = memoryRecords();
    let publishCalls = 0;
    let linkShowCalls = 0;
    const links = createShareLinks({ signer: async () => signer, fetchFn: input.fetchFn, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    const services: ShareCommandServices = {
      targetAdapter: { publish: async () => { publishCalls += 1; return published; } },
      records: storage,
      links: { ...links, show: (...args) => { linkShowCalls += 1; return links.show(...args); } },
      ...(input.invitations === undefined ? {} : { shortLinkInvitations: input.invitations }),
    };
    const command = ["publish", file, "--to", "alice@example.com", "--credential-descriptor", descriptorPath,
      "--issuer-did", "did:web:issuer.credentials.org", "--issuer-kid", "did:web:issuer.credentials.org#controller", ...args];
    const result = input.rootJson === true
      ? (configureShareCommandServices(services), await runShareCaptured(["--json", "share", ...command]))
      : await run(command, services);
    return { ...result, published, records, publishCalls, linkShowCalls };
  }

  test("prints the short link and keeps that same link in history", async () => {
    const api = stubApi();
    const result = await publish([], { fetchFn: api.fetchFn });
    const printed = result.stdout.trim();
    expect(shortLinkId(printed)).toBeDefined();
    expect(result.records.get("share-cmd")?.link).toBe(printed);
    expect(result.stderr).toBe("");
    expect(printed).not.toContain("/s/full");
  });

  test("JSON publish creates one short link, records it, and keeps the URL out of JSON", async () => {
    const api = stubApi();
    const result = await publish(["--expires", "1d", "--json"], { fetchFn: api.fetchFn, productionShape: true });
    const recordedLink = result.records.get("share-cmd")?.link;
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.linkShowCalls).toBe(1);
    expect(api.requests).toHaveLength(1);
    expect(result.publishCalls).toBe(1);
    expect(shortLinkId(recordedLink)).toBeDefined();
    expect(result.stderr).toBe("");
    expect(output.history).toEqual({ recorded: true });
    expect(result.stdout).not.toContain(recordedLink!);
    expect(result.stdout).not.toContain(result.published.url);
    expect(result.stdout).not.toContain(result.published.deliveryMaterial!.envelopeKey);
  });

  test("global JSON publish creates one short link from a production-shaped result", async () => {
    const api = stubApi();
    const result = await publish(["--expires", "1d"], { fetchFn: api.fetchFn, productionShape: true, rootJson: true });

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.linkShowCalls).toBe(1);
    expect(api.requests).toHaveLength(1);
    expect(result.publishCalls).toBe(1);
    expect(shortLinkId(result.records.get("share-cmd")?.link)).toBeDefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(result.published.url);
    expect(result.stdout).not.toContain(result.published.deliveryMaterial!.envelopeKey);
  });

  test("a policy result with a mismatched full link makes no links request", async () => {
    const api = stubApi();
    const published = await publishedShare("share-a");
    const other = await publishedShare("share-b");
    const withoutMaterial = { ...published, url: other.url, deliveryMaterial: undefined };

    const shown = await createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }).show(withoutMaterial, { fullLink: false });

    expect(shown.short).toBe(false);
    expect(shown.notice).toBeDefined();
    expect(api.requests).toHaveLength(0);
  });

  test("JSON publish recovers a short link when the publisher omits delivery material", async () => {
    const api = stubApi();
    const result = await publish(["--expires", "1d", "--json"], { fetchFn: api.fetchFn, omitMaterial: true });

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.linkShowCalls).toBe(1);
    expect(result.stderr).toBe("");
    expect(api.requests).toHaveLength(1);
    expect(shortLinkId(result.records.get("share-cmd")?.link)).toBeDefined();
    expect(result.stdout).not.toContain(result.published.url);
    expect(result.stdout).not.toContain(result.published.key);
  });

  test("--full-link prints the full link and creates nothing", async () => {
    const api = stubApi();
    const result = await publish(["--full-link"], { fetchFn: api.fetchFn });
    expect(result.stdout).toBe(`${result.published.url}\n`);
    expect(result.records.get("share-cmd")?.link).toBe(result.published.url);
    expect(api.requests).toEqual([]);
  });

  test("a share over 30 days prints the full link, the warning on stderr, and linkNotice in JSON", async () => {
    const api = stubApi();
    const human = await publish([], { fetchFn: api.fetchFn, lifetimeSeconds: 31 * 86_400 });
    expect(human.stdout).toBe(`${human.published.url}\n`);
    expect(human.stderr).toBe(`${LINK_EXPIRY_WARNING}\n`);
    const json = await publish(["--json"], { fetchFn: api.fetchFn, lifetimeSeconds: 31 * 86_400 });
    expect((JSON.parse(json.stdout) as { linkNotice?: string }).linkNotice).toBe(LINK_EXPIRY_WARNING);
    expect(api.requests).toEqual([]);
  });

  test("a refusing or unreachable API never fails the publish: full link, a notice on stderr, linkNotice in JSON", async () => {
    const refused = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); }) as unknown as typeof fetch;
    const blackhole = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    const serverError = (async () => new Response("<html>oops</html>", { status: 500 })) as unknown as typeof fetch;
    const garbage201 = (async () => new Response("not json", { status: 201 })) as unknown as typeof fetch;
    const cases: Array<[string, typeof fetch, string]> = [
      ["rate limited", stubApi({ createStatus: 429 }).fetchFn, "rate limiting"],
      ["refused", refused, "could not be reached"],
      ["blackhole", blackhole, "could not be reached"],
      ["HTTP 500", serverError, "refused this share"],
      ["garbage 201", garbage201, "answered incorrectly"],
    ];
    for (const [label, fetchFn, reason] of cases) {
      const started = Date.now();
      const human = await publish([], { fetchFn, timeoutMs: 50 });
      expect({ label, exit: human.exitCode ?? 0 }).toEqual({ label, exit: 0 });
      expect(human.stdout).toBe(`${human.published.url}\n`);
      expect(human.stderr).toContain("printing the full link instead");
      expect(human.stderr).toContain(reason);
      expect(human.records.get("share-cmd")?.link).toBe(human.published.url);
      const json = await publish(["--json"], { fetchFn, timeoutMs: 50 });
      const notice = (JSON.parse(json.stdout) as { linkNotice?: string }).linkNotice;
      expect({ label, notice: notice?.includes("printing the full link instead") }).toEqual({ label, notice: true });
      expect(json.stdout).not.toContain(json.published.key);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  test("share show --reveal-link prints the link the share printed", async () => {
    const api = stubApi();
    const result = await publish([], { fetchFn: api.fetchFn });
    const { storage } = memoryRecords();
    await storage.put(result.records.get("share-cmd")!);
    const shown = await run(["show", "share-cmd", "--reveal-link"], { records: storage });
    expect((JSON.parse(shown.stdout) as { link?: string }).link).toBe(result.stdout.trim());
  });

  test("share unlink deletes the short link; revoke makes no links request and reports no short-link field", async () => {
    const api = stubApi();
    const published = await publish([], { fetchFn: api.fetchFn });
    const record = published.records.get("share-cmd")!;
    const { storage } = memoryRecordsWith({ ...record, ownerDid: signer.did, enforcementDelegationCid: "bafy-enforcement-root" });
    const links = createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn });

    const requestsBefore = api.requests.length;
    let revoked = 0;
    const revoke = await run(["revoke", "share-cmd", "--json"], {
      records: storage,
      links,
      revocation: { revokePolicyRoot: async () => { revoked += 1; } },
    });
    expect(revoked).toBe(1);
    expect(api.requests.length).toBe(requestsBefore);
    expect(Object.keys(JSON.parse(revoke.stdout) as object).sort()).toEqual(["protocol", "result", "version"]);
    expect(revoke.stderr).toBe("");
    expect(api.stored.size).toBe(1);

    const unlink = await run(["unlink", "share-cmd", "--json"], { records: storage, links });
    expect(JSON.parse(unlink.stdout)).toEqual({ protocol: "tinycloud-share", version: 1, result: { state: "deleted", shareId: "share-cmd" } });
    expect(api.stored.size).toBe(0);
    const again = await run(["unlink", "share-cmd"], { records: storage, links });
    expect(again.stdout).toBe("absent\n");
  });

  test("share unlink on a full-link share refuses before any request", async () => {
    const api = stubApi();
    const published = await publish(["--full-link"], { fetchFn: api.fetchFn });
    const { storage } = memoryRecordsWith(published.records.get("share-cmd")!);
    const result = await run(["unlink", "share-cmd"], { records: storage, links: createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }) });
    expect(result.exitCode).toBe(2);
    expect(api.requests).toEqual([]);
  });

  test("share unlink reports a links service that cannot be reached", async () => {
    const api = stubApi();
    const published = await publish([], { fetchFn: api.fetchFn });
    const { storage } = memoryRecordsWith(published.records.get("share-cmd")!);
    const offline = createShareLinks({ signer: async () => signer, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, timeoutMs: 50 });
    const result = await run(["unlink", "share-cmd"], { records: storage, links: offline });
    expect(result.exitCode).toBe(4);
    expect(api.stored.size).toBe(1);
  });

  test("invitations fail closed until the services accept short links: publish --notify publishes nothing, notify sends nothing", async () => {
    const api = stubApi();
    const published = await publish(["--notify"], { fetchFn: api.fetchFn });
    expect(published.exitCode).toBe(4);
    expect(published.stderr).toContain("Invitation emails are not available yet. Nothing was shared and no invitation was sent.");
    expect(published.publishCalls).toBe(0);
    expect(published.stdout).toBe("");
    expect(api.requests).toEqual([]);

    const shared = await publish([], { fetchFn: api.fetchFn });
    const { storage } = memoryRecordsWith(shared.records.get("share-cmd")!);
    let delivered = 0;
    const notify = await run(["notify", "share-cmd", "--to", "alice@example.com"], { records: storage, delivery: { deliver: async () => { delivered += 1; return "delivered"; } } });
    expect(notify.exitCode).toBe(4);
    expect(notify.stderr).toContain("Invitation emails are not available yet. No invitation was sent.");
    expect(delivered).toBe(0);
  });

  test("once enabled, notify carries only a short link", async () => {
    const api = stubApi();
    const full = await publish(["--full-link"], { fetchFn: api.fetchFn });
    const fullRecord: SenderShareRecord = { ...full.records.get("share-cmd")!, actions: ["tinycloud.kv/get"] };
    let delivered: string | undefined;
    const delivery = { deliver: async (request: { readonly record?: SenderShareRecord }) => { delivered = request.record?.link; return "delivered" as const; } };
    const refused = await run(["notify", "share-cmd", "--to", "alice@example.com"], { records: memoryRecordsWith(fullRecord).storage, delivery, shortLinkInvitations: true });
    expect(refused.exitCode).toBe(2);
    expect(delivered).toBeUndefined();

    const short = await publish([], { fetchFn: api.fetchFn });
    const shortRecord: SenderShareRecord = { ...short.records.get("share-cmd")!, actions: ["tinycloud.kv/get"] };
    const sent = await run(["notify", "share-cmd", "--to", "alice@example.com"], { records: memoryRecordsWith(shortRecord).storage, delivery, shortLinkInvitations: true });
    expect(sent.exitCode ?? 0).toBe(0);
    expect(delivered).toBe(shortRecord.link);
  });

  test("the node's refusal of a delivery authorization (its 422 and its 400) is final: one attempt, not retryable, the same exit code and output, naming neither link nor key", async () => {
    const api = stubApi();
    const short = await publish([], { fetchFn: api.fetchFn });
    const record: SenderShareRecord = { ...short.records.get("share-cmd")!, actions: ["tinycloud.kv/get"] };
    const outputs: { readonly stdout: string; readonly stderr: string; readonly exitCode: number | undefined }[] = [];
    // The node answers 422 (body did not parse) or 400 (failed its checks); the node SDK raises this one error for both.
    for (let answer = 0; answer < 2; answer += 1) {
      const delivery = {
        deliver: async (): Promise<"delivered"> => { throw new ShareDeliveryRefusedError(); },
      };
      outputs.push(await run(["notify", "share-cmd", "--to", "alice@example.com", "--json"], { records: memoryRecordsWith(record).storage, delivery, shortLinkInvitations: true }));
    }
    expect(outputs[0]!.exitCode).toBe(9);
    expect(outputs[1]).toEqual(outputs[0]!);
    expect(JSON.parse(outputs[0]!.stdout)).toMatchObject({ state: "partial-failure", retryable: false, attempts: 1 });
    for (const text of [outputs[0]!.stdout, outputs[0]!.stderr]) {
      expect(text).not.toContain(record.link!);
      expect(text).not.toContain(short.published.key);
    }
    // A partial failure sets exit 9, and Bun keeps a numeric exit code that is assigned undefined: clear it for the next test.
    process.exitCode = 0;
  });

  test("keeps over-limit addressed publishes at MAX_BYTES_EXCEEDED without creating a short link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-limit-"));
    const file = join(directory, "note.md");
    const descriptorPath = join(directory, "email-descriptor.json");
    await writeFile(file, "# note\n");
    await writeFile(descriptorPath, JSON.stringify(emailDescriptor));
    const api = stubApi();
    const email = [
      "--to", "alice@example.com",
      "--credential-descriptor", descriptorPath,
      "--issuer-did", "did:web:issuer.credentials.org",
      "--issuer-kid", "did:web:issuer.credentials.org#controller",
    ] as const;
    const errorCode = (stderr: string) => {
      const start = stderr.lastIndexOf('{\n  "error"');
      const document: unknown = JSON.parse(stderr.slice(start));
      if (typeof document !== "object" || document === null || !("error" in document)) throw new Error("CLI error document is missing error");
      const error = document.error;
      if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") throw new Error("CLI error document is missing error code");
      return error.code;
    };

    let publishCalls = 0;
    const limited = await run(["publish", file, ...email, "--max-bytes", "3", "--json"], {
      targetAdapter: { publish: async () => { publishCalls += 1; throw new Error("input limit must refuse before publish"); } },
      links: createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }),
    });
    expect(errorCode(limited.stderr)).toBe("MAX_BYTES_EXCEEDED");
    expect(limited.exitCode).toBe(7);
    expect(limited.stdout).toBe("");
    expect(publishCalls).toBe(0);
    expect(api.requests).toEqual([]);

    const refused = await run(["publish", file, ...email, "--json"], {
      targetAdapter: { publish: async () => { throw new SharePublishError("max-bytes-exceeded", ADDRESSED_SHARE_TOO_LARGE_MESSAGE); } },
      links: createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }),
    });
    expect(errorCode(refused.stderr)).toBe("MAX_BYTES_EXCEEDED");
    expect(refused.exitCode).toBe(7);
    expect(refused.stdout).toBe("");

    const removed = await run(["publish", file, ...email, "--json"], {
      targetAdapter: { publish: async () => { throw new SharePublishAuthorityError({ kind: "over-limit", remaining: ["a policy record stays on your node with both of its roots revoked, so it admits no one"] }); } },
      links: createShareLinks({ signer: async () => signer, fetchFn: api.fetchFn }),
    });
    expect(errorCode(removed.stderr)).toBe("MAX_BYTES_EXCEEDED");
    expect(removed.exitCode).toBe(7);
    expect(removed.stdout).toBe("");
    expect(api.requests).toEqual([]);
  });

  const SHORT_CID = "bafkreibm6jg3ux5qucnwb24kinphs4b5fbc7n5t3lti2skm4du5qjn4fli";
  const linkAt = (origin: string) => buildShortLink({ origin, type: "share", id: "a".repeat(26), key: new Uint8Array(32).fill(7), bodyCid: SHORT_CID });

  test("a link at an untrusted origin makes no request, for receive and for inspect", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ error: "not_found" }), { status: 404 }); }) as unknown as typeof fetch;
    try {
      for (const command of ["receive", "inspect"]) {
        const refused = await run([command, linkAt("https://share.example.evil.example"), "--viewer-origin", ORIGIN], {});
        expect({ command, exit: refused.exitCode }).toEqual({ command, exit: 5 });
      }
      expect(calls).toBe(0);
      // The same link at the trusted origin does reach the API, so the count above is meaningful.
      const trusted = await run(["receive", linkAt(ORIGIN), "--viewer-origin", ORIGIN], {});
      expect(trusted.exitCode).toBe(4);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an HTTP 5xx answer to a delete is UNAVAILABLE (exit 4) and the short link stays", async () => {
    const healthy = stubApi();
    const published = await publish([], { fetchFn: healthy.fetchFn });
    const { storage } = memoryRecordsWith(published.records.get("share-cmd")!);
    const failing = stubApi({ deleteStatus: 503 });
    const result = await run(["unlink", "share-cmd"], { records: storage, links: createShareLinks({ signer: async () => signer, fetchFn: failing.fetchFn }) });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("the links service refused the request");
    expect(failing.requests.filter((request) => request.url.endsWith("/delete"))).toHaveLength(1);
    expect(healthy.stored.size).toBe(1);
  });

  test("an endless streamed record is cut off at the limit without being read", async () => {
    let pulled = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
    }), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(new TextEncoder().encode(JSON.stringify({ header: {} }))) },
    })) as unknown as typeof fetch;
    try {
      const result = await run(["receive", linkAt(ORIGIN), "--viewer-origin", ORIGIN], {});
      expect(result.exitCode).toBe(7);
      expect(pulled).toBeLessThan(10);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a body that stalls after the 201 headers hits the timeout and falls back", async () => {
    const stalledBody = ((_input: string | URL | Request, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); },
    }), { status: 201 }))) as unknown as typeof fetch;
    const started = Date.now();
    const result = await publish([], { fetchFn: stalledBody, timeoutMs: 50 });
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toBe(`${result.published.url}\n`);
    expect(result.stderr).toContain("printing the full link instead");
    expect(result.stderr).toContain("the links service could not be reached");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  function memoryRecordsWith(record: SenderShareRecord) {
    const memory = memoryRecords();
    memory.records.set(record.shareId, record);
    return memory;
  }
});
