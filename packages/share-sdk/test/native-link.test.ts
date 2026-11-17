import { describe, expect, it } from "bun:test";
import { canonicalize, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { buildShortLink, prepareLinkRecord, signerFromSeed, type LinkRecord } from "@tinycloud/share-envelope/links";
import { NATIVE_SHARE_LINK_FORMAT, NativeShareLinkError, openNativeShareLink, publishNativeShareLink } from "../src/native-link.js";

const API = "https://api.tinycloud.xyz";
const APP = "https://tinycloud.one";
const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const OWNER = "0x00000000000000000000000000000000000000aa";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:default`;
const TOKEN = `tc1:${toBase64Url(new TextEncoder().encode(JSON.stringify({ spaceId: SPACE, key: { d: "SECRET-SHARE-KEY" }, version: 1 })))}`;
const DISPLAY = { senderName: "Alex Chen", title: "Product sync", durationSeconds: 1920, includes: ["transcript", "audio"] };

interface Seen { readonly url: string; readonly method: string; readonly body: string | undefined }

/** Stores the one record it is sent and serves it back as the links API read does. */
function linksService() {
  let record: LinkRecord | undefined;
  const seen: Seen[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const request = { url: String(input), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined };
    seen.push(request);
    if (request.method === "POST" && request.url === `${API}/v1/links`) {
      record = JSON.parse(request.body ?? "") as LinkRecord;
      return new Response(JSON.stringify({ id: ID, expiresAt: record.header.expiresAt }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (record === undefined || request.url !== `${API}/v1/links/${ID}`) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const { body, ...stored } = record;
    return new Response(fromBase64Url(body), { status: 200, headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(new TextEncoder().encode(canonicalize(stored))) } });
  }) as typeof globalThis.fetch;
  return { fetch, seen, put: (value: LinkRecord) => { record = value; } };
}

const publish = (service: ReturnType<typeof linksService>, overrides: Partial<Parameters<typeof publishNativeShareLink>[0]> = {}) => publishNativeShareLink({
  token: TOKEN, kind: "recording", display: DISPLAY, linkOrigin: APP, apiOrigin: API,
  expiresAt: new Date(NOW + 7 * 86_400_000), now: NOW, fetch: service.fetch, ...overrides,
});
const open = (link: string, service: ReturnType<typeof linksService>) => openNativeShareLink(link, { trustedOrigins: [APP], apiOrigin: API, now: NOW + 1000, fetch: service.fetch });

async function refusal(promise: Promise<unknown>): Promise<NativeShareLinkError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NativeShareLinkError);
    return error as NativeShareLinkError;
  }
  throw new Error("expected a refusal");
}

describe("native share links", () => {
  it("round-trips the token, kind and display, and names the sharing account", async () => {
    const service = linksService();
    const created = await publish(service);
    expect(created.link).toStartWith(`${APP}/s/${ID}#v=4&k=`);
    expect(created.expiresAt).toBe("2026-10-31T12:00:00.000Z");
    const opened = await open(created.link, service);
    expect(opened.kind).toBe("recording");
    expect(opened.display).toEqual(DISPLAY);
    expect(opened.token).toBe(TOKEN);
    expect(opened.owner).toEqual({ address: OWNER, chainId: 1, spaceId: SPACE });
    expect(opened.linkExpiresAt.toISOString()).toBe("2026-10-31T12:00:00.000Z");
  });

  it("sends the links service only sealed bytes: no token, share key, display or content key", async () => {
    const service = linksService();
    const created = await publish(service);
    const key = /k=([A-Za-z0-9_-]{43})/.exec(created.link)![1]!;
    const requests = service.seen.map((request) => `${request.url} ${request.body ?? ""}`).join("\n");
    for (const secret of [TOKEN, "SECRET-SHARE-KEY", "Alex Chen", key]) expect(requests).not.toContain(secret);
    await open(created.link, service);
    expect(service.seen.map((request) => request.url).join("\n")).not.toContain(key);
  });

  it("refuses a body whose signature does not verify", async () => {
    const service = linksService();
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
    const issuerKey = signerFromSeed(seed);
    const body = { format: NATIVE_SHARE_LINK_FORMAT, kind: "recording", share: TOKEN, display: DISPLAY, signature: { signerDid: issuerKey.did, algorithm: "Ed25519", value: toBase64Url(new Uint8Array(64)) } };
    const prepared = await prepareLinkRecord({ type: "share", plaintext: new TextEncoder().encode(canonicalize(body)), issuerKey, apiOrigin: API, expiresAt: new Date(NOW + 86_400_000), now: NOW });
    service.put(prepared.record);
    const link = buildShortLink({ origin: APP, type: "share", id: ID, key: prepared.key, bodyCid: prepared.bodyCid });
    expect((await refusal(open(link, service))).code).toBe("invalid");
  });

  it("refuses a share body of another format", async () => {
    const service = linksService();
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
    const issuerKey = signerFromSeed(seed);
    const body = { version: 3, signature: { signerDid: issuerKey.did, algorithm: "Ed25519", value: "x" } };
    const prepared = await prepareLinkRecord({ type: "share", plaintext: new TextEncoder().encode(canonicalize(body)), issuerKey, apiOrigin: API, expiresAt: new Date(NOW + 86_400_000), now: NOW });
    service.put(prepared.record);
    const link = buildShortLink({ origin: APP, type: "share", id: ID, key: prepared.key, bodyCid: prepared.bodyCid });
    expect((await refusal(open(link, service))).code).toBe("invalid");
  });

  it("refuses a link on an origin the reader does not trust", async () => {
    const service = linksService();
    const created = await publish(service, { linkOrigin: "https://elsewhere.example" });
    expect((await refusal(open(created.link, service))).code).toBe("invalid");
  });

  it("reports an unknown or deleted record as gone, and a dead service as unavailable", async () => {
    const service = linksService();
    const created = await publish(service);
    const other = linksService();
    expect((await refusal(open(created.link, other))).code).toBe("gone");
    const down = (async () => { throw new TypeError("network down"); }) as unknown as typeof globalThis.fetch;
    expect((await refusal(openNativeShareLink(created.link, { trustedOrigins: [APP], apiOrigin: API, now: NOW, fetch: down }))).code).toBe("unavailable");
  });

  it("refuses an opened link after its window", async () => {
    const service = linksService();
    const created = await publish(service, { expiresAt: new Date(NOW + 86_400_000) });
    const late = openNativeShareLink(created.link, { trustedOrigins: [APP], apiOrigin: API, now: NOW + 86_400_000 + 1, fetch: service.fetch });
    expect((await refusal(late)).code).toBe("expired");
  });

  it("refuses before any request: a window past 30 days, an oversized display, a non-share token, a bad kind", async () => {
    const service = linksService();
    expect((await refusal(publish(service, { expiresAt: new Date(NOW + 31 * 86_400_000) }))).code).toBe("invalid");
    expect((await refusal(publish(service, { display: { title: "x".repeat(9000) } }))).code).toBe("invalid");
    expect((await refusal(publish(service, { token: "tc1:bm90LWpzb24" }))).code).toBe("invalid");
    expect((await refusal(publish(service, { kind: "Recording!" }))).code).toBe("invalid");
    expect(service.seen).toHaveLength(0);
  });
});
