/**
 * Named-key client tests. Hermetic: `fetch` is a recording router standing in
 * for a node, so every assertion is on the exact request that would be sent.
 * NOT run against a real node (none advertises `encryption-named-keys-v1` yet).
 */
import { describe, expect, it } from "bun:test";

import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
  canonicalize,
  hexEncode,
  utf8Encode,
} from "./canonical";
import {
  buildKeyAdminFacts,
  mapNodeKeyError,
  NamedKeyClient,
  NamedKeyError,
  type NamedKeyClientConfig,
  type NamedKeyEnvelope,
  type NamedKeyInvocationInput,
} from "./namedKeys";
import {
  formatKeyResource,
  formatPrefixResource,
  KEY_BLOCK_ABILITY,
  KEY_CREATE_ABILITY,
  KEY_UNBLOCK_ABILITY,
} from "./resource";
import { DECRYPT_ACTION, DECRYPT_RESULT_TYPE, type EncryptionCrypto, type InlineEncryptedEnvelope } from "./types";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK_ID = `urn:tinycloud:encryption:${OWNER}:default`;
const HOST = "https://node.test";
const NODE = "did:key:z6MkNodeUnderTest";
const PATH = "secrets/software-factory";
const KEY_URN = formatKeyResource(NETWORK_ID, PATH);
const KEY_PUB = new Uint8Array(32).fill(7);
const ROOT_PUB = new Uint8Array(32).fill(3);

function sha256(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    out[i] = h & 0xff;
  }
  return out;
}
function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  return data.map((b, i) => b ^ key[i % key.length]!);
}
let rng = 1;
const crypto: EncryptionCrypto = {
  sha256,
  randomBytes: (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      out[i] = rng & 0xff;
    }
    return out;
  },
  // Fake X25519: the "public key" is the seed, so the fake node can wrap to it.
  x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
  x25519Dh: (a, b) => xor(a, b),
  authEncrypt: (key, plaintext) => xor(key, plaintext),
  authDecrypt: (key, ciphertext) => xor(key, ciphertext),
  sealToNetworkKey: (pub, sym) => xor(pub, sym),
  openWithReceiverKey: (priv, wrapped) => xor(priv, wrapped),
  verifyNodeSignature: () => true,
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (req: Recorded) => Response | undefined;

const text = (body: string, status: number) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const infoOn = () => json({ nodeId: NODE, features: ["encryption-named-keys-v1"] });
const infoOff = () => json({ nodeId: NODE, features: ["sql"] });

const descriptor = (over: Record<string, unknown> = {}) => ({
  networkId: NETWORK_ID,
  keyPath: PATH,
  alg: "x25519-aes256gcm/v1",
  keyVersion: 1,
  publicEncryptionKey: base64Encode(KEY_PUB),
  state: "active",
  kind: "deterministic",
  createdAt: "t0",
  updatedAt: "t0",
  ...over,
});

function harness(handler: Handler, opts: { info?: () => Response } = {}) {
  const requests: Recorded[] = [];
  const signed: NamedKeyInvocationInput[] = [];
  const rootDecrypts: InlineEncryptedEnvelope[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req: Recorded = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    requests.push(req);
    if (url === `${HOST}/info`) return (opts.info ?? infoOn)();
    const res = handler(req);
    if (!res) throw new Error(`unexpected fetch ${req.method} ${url}`);
    return res;
  }) as typeof fetch;
  const config: NamedKeyClientConfig = {
    host: HOST,
    crypto,
    fetch: fetchImpl,
    defaultNetworkId: () => NETWORK_ID,
    signInvocation: async (input) => {
      signed.push(input);
      return { authorization: `Bearer ${signed.length}:${input.action}`, invocationCid: `cid${signed.length}` };
    },
    decryptRoot: async (envelope) => {
      rootDecrypts.push(envelope);
      return { ok: true, data: utf8Encode("root-plaintext") };
    },
  };
  return { client: new NamedKeyClient(config), requests, signed, rootDecrypts };
}

const keyRequests = (rs: Recorded[]) => rs.filter((r) => r.url !== `${HOST}/info`);
const KEYS_URL = `${HOST}/encryption/networks/${encodeURIComponent(NETWORK_ID)}/keys`;

describe("feature gate", () => {
  it("throws NAMED_KEYS_UNSUPPORTED and sends no key request when the node lacks the feature", async () => {
    const h = harness(() => undefined, { info: infoOff });
    const calls = [
      () => h.client.getPublicKey(PATH),
      () => h.client.describeKey(PATH),
      () => h.client.createKey(PATH),
      () => h.client.blockKey(PATH),
      () => h.client.unblockKey(PATH),
      () => h.client.ensureKey(PATH),
      () => h.client.encrypt(PATH, utf8Encode("x")),
      () =>
        h.client.decrypt({
          v: 2,
          networkId: NETWORK_ID,
          keyPath: PATH,
          alg: "a",
          keyVersion: 1,
          encryptedSymmetricKey: "AA==",
          encryptedSymmetricKeyHash: canonicalHashHex(sha256, "AA=="),
          ciphertext: "AA==",
        }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "NAMED_KEYS_UNSUPPORTED" });
    }
    expect(keyRequests(h.requests)).toHaveLength(0);
    expect(h.signed).toHaveLength(0);
  });

  it("does not gate v1 (root-key) decrypt", async () => {
    const h = harness(() => undefined, { info: infoOff });
    const v1: InlineEncryptedEnvelope = {
      v: 1,
      networkId: NETWORK_ID,
      alg: "a",
      keyVersion: 1,
      encryptedSymmetricKey: "AA==",
      encryptedSymmetricKeyHash: "h",
      ciphertext: "AA==",
    };
    expect(await h.client.decrypt(v1)).toEqual(utf8Encode("root-plaintext"));
    expect(h.requests).toHaveLength(0);
  });
});

describe("key targets", () => {
  it("refuses a prefix or bare network as an invocation target before any request", () => {
    const prefix = formatPrefixResource(NETWORK_ID, "apps/tinychat");
    for (const target of [prefix, NETWORK_ID]) {
      expect(() =>
        buildKeyAdminFacts({ crypto, targetNode: NODE, keyResource: target, action: KEY_CREATE_ABILITY, body: {} }),
      ).toThrow(NamedKeyError);
    }
  });

  it("rejects a path that is not an exact key path (trailing slash) with zero requests", async () => {
    const h = harness(() => undefined);
    await expect(h.client.createKey("apps/tinychat/")).rejects.toMatchObject({ code: "INVALID_KEY_TARGET" });
    await expect(h.client.createKey("Apps/x")).rejects.toMatchObject({ code: "INVALID_KEY_TARGET" });
    expect(h.requests).toHaveLength(0);
    expect(h.signed).toHaveLength(0);
  });
});

describe("admin routes", () => {
  const cases = [
    { name: "create", call: (c: NamedKeyClient) => c.createKey(PATH), route: "keys", can: KEY_CREATE_ABILITY, body: '{"keyPath":"secrets/software-factory","shreddable":false}' },
    { name: "block", call: (c: NamedKeyClient) => c.blockKey(PATH), route: "key-actions/block", can: KEY_BLOCK_ABILITY, body: '{"keyPath":"secrets/software-factory"}' },
    { name: "unblock", call: (c: NamedKeyClient) => c.unblockKey(PATH), route: "key-actions/unblock", can: KEY_UNBLOCK_ABILITY, body: '{"keyPath":"secrets/software-factory"}' },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: exact URL, body bytes, one capability on the exact key, key-admin facts`, async () => {
      const h = harness(() => json(descriptor()));
      await c.call(h.client);
      const [req] = keyRequests(h.requests);
      expect(req!.method).toBe("POST");
      expect(req!.url).toBe(`${HOST}/encryption/networks/${encodeURIComponent(NETWORK_ID)}/${c.route}`);
      expect(req!.body).toBe(c.body);
      expect(req!.headers.Authorization).toBe(`Bearer 1:${c.can}`);
      expect(h.signed).toHaveLength(1);
      expect(h.signed[0]!.resource).toBe(KEY_URN);
      expect(h.signed[0]!.action).toBe(c.can);
      expect(h.signed[0]!.facts).toEqual({
        type: "tinycloud.encryption.key-admin/v1",
        targetNode: NODE,
        networkId: NETWORK_ID,
        keyPath: PATH,
        action: c.can,
        // Same canonical hash as network-admin: hash of the exact body bytes sent.
        bodyHash: hexEncode(sha256(utf8Encode(req!.body!))),
      });
      expect(h.signed[0]!.facts.bodyHash).toBe(canonicalHashHex(sha256, JSON.parse(c.body)));
    });
  }

  it("never sends shreddable: true or a delete route", async () => {
    const h = harness(() => json(descriptor()));
    await h.client.createKey(PATH);
    const all = keyRequests(h.requests).map((r) => `${r.url} ${r.body ?? ""}`).join("\n");
    expect(all).not.toContain("true");
    expect(all).not.toContain("delete");
  });
});

describe("GETs", () => {
  it("public GET carries no Authorization and mints no invocation", async () => {
    const h = harness(() => json({ ...descriptor(), state: undefined, kind: undefined }));
    const result = await h.client.getPublicKey(PATH);
    const [req] = keyRequests(h.requests);
    expect(req!.method).toBe("GET");
    expect(req!.url).toBe(`${KEYS_URL}/${PATH}`);
    expect(req!.headers.Authorization).toBeUndefined();
    expect(h.signed).toHaveLength(0);
    expect(result.publicEncryptionKey).toBe(base64Encode(KEY_PUB));
  });

  it("authenticated GET: one capability on the exact key, key-describe facts without bodyHash", async () => {
    const h = harness(() => json(descriptor()));
    const d = await h.client.describeKey(PATH, { ability: KEY_BLOCK_ABILITY });
    expect(d?.state).toBe("active");
    const [req] = keyRequests(h.requests);
    expect(req!.url).toBe(`${KEYS_URL}/${PATH}`);
    expect(req!.headers.Authorization).toBe(`Bearer 1:${KEY_BLOCK_ABILITY}`);
    expect(req!.body).toBeUndefined();
    expect(h.signed[0]).toEqual({
      targetNode: NODE,
      resource: KEY_URN,
      action: KEY_BLOCK_ABILITY,
      facts: {
        type: "tinycloud.encryption.key-describe/v1",
        targetNode: NODE,
        networkId: NETWORK_ID,
        keyPath: PATH,
      },
    });
  });

  it("authenticated GET returns null on key_not_found but throws on network_not_found", async () => {
    const missing = harness(() => text("key_not_found: no such key", 404));
    expect(await missing.client.describeKey(PATH)).toBeNull();
    const noNet = harness(() => text("network_not_found: x", 404));
    await expect(noNet.client.describeKey(PATH)).rejects.toMatchObject({ code: "NETWORK_NOT_FOUND" });
  });

  it("describe refuses abilities that cannot describe a key", async () => {
    const h = harness(() => json(descriptor()));
    await expect(
      h.client.describeKey(PATH, { ability: "tinycloud.encryption/key.delete" }),
    ).rejects.toMatchObject({ code: "INVALID_KEY_TARGET" });
    expect(h.signed).toHaveLength(0);
  });
});

describe("ensureKey", () => {
  const route = (steps: Array<(r: Recorded) => Response>) => {
    let i = 0;
    return (r: Recorded) => {
      const step = steps[i++];
      if (!step) throw new Error(`unexpected extra request ${r.method} ${r.url}`);
      return step(r);
    };
  };

  it("404 -> create -> active deterministic", async () => {
    const h = harness(
      route([() => text("key_not_found: x", 404), () => json(descriptor())]),
    );
    const d = await h.client.ensureKey(PATH);
    expect(d.state).toBe("active");
    expect(keyRequests(h.requests).map((r) => r.method)).toEqual(["GET", "POST"]);
    // Both invocations are single-capability key.create on the exact key.
    expect(h.signed.map((s) => [s.action, s.resource])).toEqual([
      [KEY_CREATE_ABILITY, KEY_URN],
      [KEY_CREATE_ABILITY, KEY_URN],
    ]);
  });

  it("active key found directly: no create", async () => {
    const h = harness(route([() => json(descriptor())]));
    await h.client.ensureKey(PATH);
    expect(keyRequests(h.requests).map((r) => r.method)).toEqual(["GET"]);
  });

  it("409 key_exists -> authenticated GET -> active is success", async () => {
    const h = harness(
      route([
        () => text("key_not_found: x", 404),
        () => text("key_exists: path exists", 409),
        () => json(descriptor()),
      ]),
    );
    expect((await h.client.ensureKey(PATH)).state).toBe("active");
    expect(keyRequests(h.requests).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("blocked key -> KEY_BLOCKED", async () => {
    const h = harness(route([() => json(descriptor({ state: "blocked" }))]));
    await expect(h.client.ensureKey(PATH)).rejects.toMatchObject({ code: "KEY_BLOCKED" });
  });

  it("non-deterministic kind -> KEY_KIND_MISMATCH even when active", async () => {
    const h = harness(route([() => json(descriptor({ kind: "shreddable" }))]));
    await expect(h.client.ensureKey(PATH)).rejects.toMatchObject({
      code: "KEY_KIND_MISMATCH",
      kind: "shreddable",
    });
  });

  it("unknown or deleted-style state surfaces KEY_UNAVAILABLE with the raw string", async () => {
    for (const state of ["deleted", "retired", "something_new"]) {
      const h = harness(route([() => json(descriptor({ state }))]));
      const error = await h.client.ensureKey(PATH).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NamedKeyError);
      expect((error as NamedKeyError).code).toBe("KEY_UNAVAILABLE");
      expect((error as NamedKeyError).rawState).toBe(state);
    }
  });

  it("a descriptor for a different key is rejected", async () => {
    const h = harness(route([() => json(descriptor({ keyPath: "secrets/other" }))]));
    await expect(h.client.ensureKey(PATH)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("error mapping", () => {
  const table: Array<[number, string, string]> = [
    [403, "key_blocked: x", "KEY_BLOCKED"],
    [404, "key_not_found: x", "KEY_NOT_FOUND"],
    [409, "key_exists: x", "KEY_EXISTS"],
    [404, "network_not_found: x", "NETWORK_NOT_FOUND"],
    [409, "network_not_active: x", "NETWORK_NOT_ACTIVE"],
    [403, "key_limit_exceeded: x", "KEY_LIMIT_EXCEEDED"],
    [403, "shreddable_unavailable: x", "SHREDDABLE_UNAVAILABLE"],
    [403, "shreddable_requires_paid_tier: x", "SHREDDABLE_REQUIRES_PAID_TIER"],
    [400, "key_path_invalid: x", "KEY_PATH_INVALID"],
    [403, "key_unwrap_failed: x", "KEY_UNWRAP_FAILED"],
    [500, "boom", "NODE_ERROR"],
    [403, "unheard_of_code: x", "NODE_ERROR"],
  ];
  for (const [status, body, code] of table) {
    it(`${status} ${body} -> ${code}`, () => {
      expect(mapNodeKeyError(status, body, "ctx").code).toBe(code);
    });
  }

  it("deleted and retired codes both map to KEY_UNAVAILABLE carrying the raw code", () => {
    for (const raw of ["key_deleted", "key_retired"]) {
      const error = mapNodeKeyError(403, `${raw}: gone`, "ctx");
      expect(error.code).toBe("KEY_UNAVAILABLE");
      expect(error.rawState).toBe(raw);
    }
  });
});

describe("envelopes", () => {
  /** Fake node for `/invoke`: unwraps with the key secret and rewraps to the receiver key. */
  const invokeNode = (secrets: Record<string, Uint8Array>, seen: Recorded[]): Handler => (req) => {
    if (req.url === `${HOST}/invoke`) {
      seen.push(req);
      const body = JSON.parse(req.body!) as Record<string, string>;
      const sym = xor(secrets[body.keyPath!]!, base64Decode(body.encryptedSymmetricKey!));
      const receiver = base64Decode(body.receiverPublicKey!);
      const invocationCid = `cid${/Bearer (\d+)/.exec(req.headers.Authorization!)![1]}`;
      const bodyHash = hexEncode(sha256(utf8Encode(req.body!)));
      return json({
        type: DECRYPT_RESULT_TYPE,
        targetNode: NODE,
        networkId: body.networkId,
        invocationCid,
        encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
        receiverPublicKeyHash: body.receiverPublicKeyHash,
        wrappedKey: base64Encode(xor(receiver, sym)),
        alg: body.alg,
        keyVersion: body.keyVersion,
        requestHash: hexEncode(sha256(utf8Encode(`${invocationCid}${bodyHash}`))),
        nodeId: NODE,
        nodeSignature: "AA==",
      });
    }
    if (req.url.startsWith(`${KEYS_URL}/`)) {
      const path = req.url.slice(KEYS_URL.length + 1);
      return json({ ...descriptor({ keyPath: path }), state: undefined, kind: undefined });
    }
    return undefined;
  };

  it("v2 encrypt wraps to the key's public key and records keyPath", async () => {
    const h = harness(invokeNode({}, []));
    const env = await h.client.encrypt(PATH, utf8Encode("hello"));
    expect(env.v).toBe(2);
    expect(env.keyPath).toBe(PATH);
    expect(env.networkId).toBe(NETWORK_ID);
    // Fake wrap is xor(pub, sym); unwrapping with the KEY public bytes recovers a key that decrypts.
    const sym = xor(KEY_PUB, base64Decode(env.encryptedSymmetricKey));
    expect(xor(sym, base64Decode(env.ciphertext))).toEqual(utf8Encode("hello"));
    expect(env.encryptedSymmetricKeyHash).toBe(canonicalHashHex(sha256, env.encryptedSymmetricKey));
  });

  it("v2 decrypt round-trips through /invoke with exactly one key capability and a matching keyPath", async () => {
    const seen: Recorded[] = [];
    const h = harness(invokeNode({ [PATH]: KEY_PUB }, seen));
    const env = await h.client.encrypt(PATH, utf8Encode("hello"));
    h.signed.length = 0;
    expect(await h.client.decrypt(env)).toEqual(utf8Encode("hello"));

    expect(h.signed).toHaveLength(1);
    const [s] = h.signed;
    expect(s!.resource).toBe(KEY_URN);
    expect(s!.action).toBe(DECRYPT_ACTION);
    expect(s!.facts.keyPath).toBe(PATH);
    expect(s!.facts.networkId).toBe(NETWORK_ID);
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    expect(body.keyPath).toBe(PATH);
    // facts.bodyHash binds the exact bytes posted.
    expect(s!.facts.bodyHash).toBe(hexEncode(sha256(utf8Encode(seen[0]!.body!))));
    expect(seen[0]!.body).toBe(canonicalize(body as never));
    // Never the direct root route.
    expect(h.requests.some((r) => r.url.endsWith("/decrypt"))).toBe(false);
  });

  it("v1 envelope decrypts through the root path unchanged: no /invoke, no key invocation, no /info", async () => {
    const h = harness(() => undefined);
    const v1: InlineEncryptedEnvelope = {
      v: 1,
      networkId: NETWORK_ID,
      alg: "a",
      keyVersion: 1,
      encryptedSymmetricKey: base64Encode(ROOT_PUB),
      encryptedSymmetricKeyHash: canonicalHashHex(sha256, base64Encode(ROOT_PUB)),
      ciphertext: "AA==",
    };
    expect(await h.client.decrypt(v1)).toEqual(utf8Encode("root-plaintext"));
    expect(h.rootDecrypts).toEqual([v1]);
    expect(h.requests).toHaveLength(0);
    expect(h.signed).toHaveLength(0);
  });

  it("mixed batch: v1 goes to the root path, each v2 key gets its own single-capability invocation", async () => {
    const seen: Recorded[] = [];
    const other = "apps/other";
    const h = harness(invokeNode({ [PATH]: KEY_PUB, [other]: KEY_PUB }, seen));
    const a = await h.client.encrypt(PATH, utf8Encode("a"));
    const b = await h.client.encrypt(other, utf8Encode("b"));
    const v1: InlineEncryptedEnvelope = {
      v: 1,
      networkId: NETWORK_ID,
      alg: "a",
      keyVersion: 1,
      encryptedSymmetricKey: "AA==",
      encryptedSymmetricKeyHash: "h",
      ciphertext: "AA==",
    };
    h.signed.length = 0;
    const results = await h.client.decryptMany([a, v1, b]);
    expect(results.map((r) => (r.ok ? new TextDecoder().decode(r.data) : r.error.code))).toEqual([
      "a",
      "root-plaintext",
      "b",
    ]);
    // v1 minted no key invocation; the two keys minted one each, never combined.
    expect(h.rootDecrypts).toHaveLength(1);
    expect(h.signed.map((s) => s.resource)).toEqual([
      formatKeyResource(NETWORK_ID, PATH),
      formatKeyResource(NETWORK_ID, other),
    ]);
    expect(seen.map((r) => (JSON.parse(r.body!) as { keyPath: string }).keyPath)).toEqual([PATH, other]);
  });

  it("rejects envelopes that mix versions and keyPath", async () => {
    const h = harness(() => undefined);
    const base = {
      networkId: NETWORK_ID,
      alg: "a",
      keyVersion: 1,
      encryptedSymmetricKey: "AA==",
      encryptedSymmetricKeyHash: canonicalHashHex(sha256, "AA=="),
      ciphertext: "AA==",
    };
    const v1WithPath = { v: 1, keyPath: PATH, ...base } as unknown as InlineEncryptedEnvelope;
    const v2NoPath = { v: 2, ...base } as unknown as NamedKeyEnvelope;
    for (const bad of [v1WithPath, v2NoPath]) {
      await expect(h.client.decrypt(bad)).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    }
    expect(h.requests).toHaveLength(0);
    expect(h.rootDecrypts).toHaveLength(0);
  });

  it("maps a node denial on /invoke to a typed error", async () => {
    const h = harness((req) => (req.url === `${HOST}/invoke` ? text("key_blocked: blocked", 403) : req.url.startsWith(KEYS_URL) ? json({ ...descriptor(), state: undefined, kind: undefined }) : undefined));
    const env = await h.client.encrypt(PATH, utf8Encode("x"));
    await expect(h.client.decrypt(env)).rejects.toMatchObject({ code: "KEY_BLOCKED", status: 403 });
  });
});
