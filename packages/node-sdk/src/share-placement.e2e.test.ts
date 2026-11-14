import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Wallet } from "ethers";
import { TinyCloudNode } from "./index";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";
import { sharePlacementDestinations, signSharePlacement, sharePlacementMessage, verifySharePlacement } from "../../sdk-core/src/share-placement";
import { signLocationRecordV2, validateLocationRecordV2, verifyLocationRecordV2 } from "../../sdk-core/src/location";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const path = "vault/secrets/HERMETIC_DELEGATION_CANARY";
async function sender(sign?: (message: string) => Promise<string>) {
  const fixture = await createHermeticEncryptedNode();
  cleanup.push(() => fixture.stop());
  const owner = new Wallet("0x" + fixture.ownerPrivateKey.replace(/^0x/, ""));
  const node = new TinyCloudNode({ host: fixture.host, tinycloudRegistryUrl: fixture.host,
    privateKey: fixture.ownerPrivateKey, autoBootstrapAccount: false,
    ...(sign ? { sharePlacementSigner: sign } : {}),
  });
  await node.restoreSession(fixture.ownerRestorableSession);
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [path]: { message: "fresh owner share" } });
  return { fixture, node, owner };
}
async function generate(node: TinyCloudNode) {
  const result = await node.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

test("fresh wallet owner creates and receives a private-placement share without publishing a registry record", async () => {
  const native = globalThis.fetch;
  let publications = 0;
  const watch = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (/\/locations\//.test(url.pathname) && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "PUT") publications++;
    return native(input, init);
  }, { preconnect: native.preconnect }));
  cleanup.push(() => watch.mockRestore());
  const { fixture, node } = await sender();
  const generated = await generate(node);
  const decoded = node.sharing.decodeLink(generated.token);
  expect(decoded.version).toBe(2);
  expect(publications).toBe(0);
  expect(decoded.placement!.ownerDid.toLowerCase()).toBe(fixture.ownerDid.toLowerCase());
  expect(() => validateLocationRecordV2(decoded.placement)).toThrow();
  const receiver = new TinyCloudNode({ tinycloudRegistryUrl: fixture.host, newUserHost: null, autoDiscoverLocalNode: false });
  const received = await receiver.sharing.receive(generated.token, { autoSubdelegate: false, useSessionKey: false });
  if (!received.ok) throw new Error(JSON.stringify(received.error));
  expect((await received.data.kv.get(path, { prefix: "" }))).toMatchObject({ ok: true, data: { data: { message: "fresh owner share" } } });
});

test("placement cannot be transplanted, altered, expired or published as a registry record", async () => {
  const { node } = await sender();
  const generated = await generate(node);
  const decoded = node.sharing.decodeLink(generated.token);
  const parent = { ...decoded.delegation, spaceId: decoded.spaceId };
  const record = decoded.placement!;
  // Even a holder translating the fields into a structurally valid registry record cannot reuse the signature.
  expect(await verifyLocationRecordV2({ version: 2, subject: record.ownerDid,
    nodes: [{ did: record.nodeDid, url: record.nodeUrl }], spaces: [{ space: record.spaceId, nodes: [{ did: record.nodeDid, mode: "read-only" }] }],
    encryptionNode: null, updated_at: record.issuedAt, sequence: 0, signature: record.signature,
  })).toBe(false);
  await expect(verifySharePlacement(record, parent)).resolves.toEqual(record);
  for (const change of [
    { parentCid: "another-parent" }, { spaceId: decoded.spaceId + "-other" },
    { nodeUrl: "https://evil.example" }, { nodeDid: decoded.keyDid },
    { ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" },
    { notAfter: new Date(Date.now() - 1).toISOString() }, { type: "tinycloud/registry-placement/v2" },
  ]) await expect(verifySharePlacement({ ...record, ...change }, parent)).rejects.toThrow();
  await expect(verifySharePlacement(record, { ...parent, cid: "other-share" })).rejects.toThrow();
  await expect(verifySharePlacement(record, parent, Date.parse(record.notAfter))).rejects.toThrow();
});

test("placement cancellation returns no share and performs no delegation activation", async () => {
  const { node, fixture } = await sender(async () => { throw new Error("placement cancelled"); });
  const before = fixture.nativeBearerStats();
  await expect(generate(node)).rejects.toThrow();
  expect(fixture.nativeBearerStats().delegationAttempts).toBe(before.delegationAttempts);
});


test("a verified current registry placement dominates; absence/outage uses only the signed destination", async () => {
  const { node, owner } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  const parent = { ...decoded.delegation, spaceId: decoded.spaceId };
  const placement = decoded.placement!;
  const current = await signLocationRecordV2({ version: 2, subject: placement.ownerDid,
    nodes: [{ did: placement.nodeDid, url: "https://current.example" }],
    spaces: [{ space: placement.spaceId, nodes: [{ did: placement.nodeDid, mode: "read-only" }] }],
    encryptionNode: null, updated_at: new Date().toISOString(), sequence: 1,
  }, { type: "did:pkh", signMessage: message => owner.signMessage(message) });
  const resolve = (fetchFn: typeof fetch) => sharePlacementDestinations(placement, parent, { registryUrl: "https://registry.example", fetch: fetchFn });
  const reply = (record: unknown) => Object.assign(async () => Response.json({ record }), { preconnect() {} }) as typeof fetch;
  expect(await resolve(reply(current))).toEqual([{ nodeDid: placement.nodeDid, url: "https://current.example" }]);
  const { signature: _signature, ...currentPayload } = current;
  const removed = await signLocationRecordV2({ ...currentPayload, spaces: [], sequence: 2 }, { type: "did:pkh", signMessage: message => owner.signMessage(message) });
  await expect(resolve(reply(removed))).rejects.toThrow();
  await expect(resolve(reply({ ...current, signature: placement.signature }))).rejects.toThrow();
  const absent = Object.assign(async () => Response.json({ error: "location record not found" }, { status: 404 }), { preconnect() {} }) as typeof fetch;
  expect(await resolve(absent)).toEqual([{ nodeDid: placement.nodeDid, url: placement.nodeUrl }]);
  const offline = Object.assign(async () => { throw new TypeError("network unavailable"); }, { preconnect() {} }) as typeof fetch;
  expect(await resolve(offline)).toEqual([{ nodeDid: placement.nodeDid, url: placement.nodeUrl }]);
});


test("remembered registry history rejects rollback and malformed responses rather than using the placement", async () => {
  const { node, owner } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  const placement = decoded.placement!;
  const parent = { ...decoded.delegation, spaceId: decoded.spaceId };
  const record = await signLocationRecordV2({ version: 2, subject: placement.ownerDid,
    nodes: [{ did: placement.nodeDid, url: placement.nodeUrl }], spaces: [{ space: placement.spaceId, nodes: [{ did: placement.nodeDid, mode: "read-only" }] }],
    encryptionNode: null, updated_at: new Date().toISOString(), sequence: 1,
  }, { type: "did:pkh", signMessage: message => owner.signMessage(message) });
  const fetchRecord = Object.assign(async () => Response.json({ record }), { preconnect() {} }) as typeof fetch;
  await expect(sharePlacementDestinations(placement, parent, { registryUrl: "https://registry.example", fetch: fetchRecord,
    sequenceStore: { get: async () => 2, set: async () => {} },
  })).rejects.toThrow();
  const badResponse = Object.assign(async () => Response.json({ unexpected: true }), { preconnect() {} }) as typeof fetch;
  await expect(sharePlacementDestinations(placement, parent, { registryUrl: "https://registry.example", fetch: badResponse })).rejects.toThrow();
});


test("unknown envelope versions fail explicitly and version 2 cannot omit its placement", async () => {
  const { node } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  const encode = (data: unknown) => "tc1:" + Buffer.from(JSON.stringify(data)).toString("base64url");
  expect(() => node.sharing.decodeLink(encode({ ...decoded, version: 3 }))).toThrow("Unsupported sharing envelope version");
  expect(() => node.sharing.decodeLink(encode({ ...decoded, placement: undefined }))).toThrow();
});


test("placement signing is explicit and cannot survive account retirement", async () => {
  const fixture = await createHermeticEncryptedNode(); cleanup.push(() => fixture.stop());
  const before = fixture.nativeBearerStats().delegationAttempts;
  const refused = await fixture.owner.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
  expect(refused).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  expect(fixture.nativeBearerStats().delegationAttempts).toBe(before);
  let active: Awaited<ReturnType<typeof sender>>;
  active = await sender(async message => {
    await active.node.signOut();
    return active.owner.signMessage(message);
  });
  const attempted = active.fixture.nativeBearerStats().delegationAttempts;
  await expect(generate(active.node)).rejects.toThrow();
  expect(active.fixture.nativeBearerStats().delegationAttempts).toBe(attempted);
});


test("malformed placement destinations are refused before asking the owner to sign", async () => {
  const { node } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  let signatures = 0;
  await expect(signSharePlacement({ ...decoded.delegation, spaceId: decoded.spaceId },
    { did: decoded.placement!.nodeDid, url: decoded.placement!.nodeUrl + "/untrusted-path" },
    async () => { signatures++; throw new Error("must not sign malformed placement"); },
  )).rejects.toThrow();
  expect(signatures).toBe(0);
});


test("share placement canonical bytes pin the independent domain and signed type", () => {
  const payload = { type: "tinycloud/share-placement/v1" as const,
    ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001", parentCid: "bafy-fixed-parent",
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
    nodeDid: "did:key:z6MkrJVcY6xCzz6qGFmYwNwSuzyLkxEMWrbhtcRbXSRwV7Hn", nodeUrl: "https://node.example",
    issuedAt: "2026-11-13T00:00:00.000Z", notAfter: "2026-11-14T00:00:00.000Z" };
  const expected = 'tinycloud/share-placement/v1\n{"type":"tinycloud/share-placement/v1","ownerDid":"did:pkh:eip155:1:0x0000000000000000000000000000000000000001","parentCid":"bafy-fixed-parent","spaceId":"tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications","nodeDid":"did:key:z6MkrJVcY6xCzz6qGFmYwNwSuzyLkxEMWrbhtcRbXSRwV7Hn","nodeUrl":"https://node.example","issuedAt":"2026-11-13T00:00:00.000Z","notAfter":"2026-11-14T00:00:00.000Z"}';
  expect(new TextEncoder().encode(sharePlacementMessage(payload))).toEqual(new TextEncoder().encode(expected));
});

test("a valid owner signature cannot bind a different parent CID", async () => {
  const { node, owner } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  const mismatched = { ...decoded.placement!, parentCid: "bafy-another-parent" };
  mismatched.signature = await owner.signMessage(sharePlacementMessage(mismatched));
  await expect(verifySharePlacement(mismatched, { ...decoded.delegation, spaceId: decoded.spaceId })).rejects.toThrow();
});

test("registry 4xx errors refuse while canonical absence and 5xx permit the signed placement", async () => {
  const { node } = await sender();
  const decoded = node.sharing.decodeLink((await generate(node)).token);
  const parent = { ...decoded.delegation, spaceId: decoded.spaceId };
  for (const status of [400, 401, 403, 404, 500, 502, 503, 504, 599]) {
    const fetchFn = Object.assign(async () => Response.json({ error: "location record not found" }, { status }), { preconnect() {} }) as typeof fetch;
    const outcome = sharePlacementDestinations(decoded.placement!, parent, { registryUrl: "https://registry.example", fetch: fetchFn });
    if (status < 500 && status !== 404) await expect(outcome).rejects.toThrow();
    else expect(await outcome).toEqual([{ nodeDid: decoded.placement!.nodeDid, url: decoded.placement!.nodeUrl }]);
  }
});


test("Node receive parse and schema errors are value-free with no cause or metadata", async () => {
  const node = new TinyCloudNode({ newUserHost: null, autoDiscoverLocalNode: false });
  const secret = "SYNTHETIC_SHARE_PRIVATE_CANARY";
  const encode = (text: string) => "tc1:" + Buffer.from(text).toString("base64url");
  for (const token of ["tc1:%%%" + secret, encode('{"version":2,"private":"' + secret + '",'), encode(JSON.stringify({ version: 2, key: secret }))]) {
    const result = await node.sharing.receive(token, { autoSubdelegate: false, useSessionKey: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid share unexpectedly accepted");
    expect(result.error).toEqual({ code: "INVALID_TOKEN", message: "Invalid sharing link data", service: "delegation" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.error).not.toHaveProperty("cause");
    expect(result.error).not.toHaveProperty("meta");
  }
});
