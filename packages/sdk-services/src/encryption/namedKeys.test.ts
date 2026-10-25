/**
 * Named-key client tests. Hermetic: `fetch` is a recording router standing in
 * for a node, so every assertion is on the exact request that would be sent.
 * The same client was also run against real nodes with the feature on (see the PR body).
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
  buildKeyDescribeFacts,
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
  // Stub X25519: the "public key" is the seed, so the stub node can wrap to it.
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
const KEYS_URL = `${HOST}/encryption/networks/${NETWORK_ID}/keys`;

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
    { name: "create", call: (c: NamedKeyClient) => c.createKey(PATH), route: "keys", can: KEY_CREATE_ABILITY, body: '{"deletable":false,"keyPath":"secrets/software-factory"}' },
    { name: "block", call: (c: NamedKeyClient) => c.blockKey(PATH), route: "key-actions/block", can: KEY_BLOCK_ABILITY, body: '{"keyPath":"secrets/software-factory"}' },
    { name: "unblock", call: (c: NamedKeyClient) => c.unblockKey(PATH), route: "key-actions/unblock", can: KEY_UNBLOCK_ABILITY, body: '{"keyPath":"secrets/software-factory"}' },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: exact URL, body bytes, one capability on the exact key, key-admin facts`, async () => {
      const h = harness(() => json(descriptor()));
      await c.call(h.client);
      const [req] = keyRequests(h.requests);
      expect(req!.method).toBe("POST");
      expect(req!.url).toBe(`${HOST}/encryption/networks/${NETWORK_ID}/${c.route}`);
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

  it("never sends deletable: true outside apps/ or a delete route", async () => {
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

describe("network id goes into the URL raw", () => {
  const DK_NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK:default";
  const missingNode = () => text("key_not_found: x", 404);

  for (const networkId of [NETWORK_ID, DK_NETWORK_ID]) {
    it(`create, block, unblock, public GET and authenticated GET carry the raw id and no '%' (${networkId.slice(0, 36)}...)`, async () => {
      const h = harness(() => json({ ...descriptor({ networkId }) }));
      const options = { networkId };
      await h.client.createKey(PATH, options);
      await h.client.blockKey(PATH, options);
      await h.client.unblockKey(PATH, options);
      await h.client.getPublicKey(PATH, options);
      await h.client.describeKey(PATH, options);
      const urls = keyRequests(h.requests).map((r) => `${r.method} ${r.url}`);
      const base = `${HOST}/encryption/networks/${networkId}`;
      expect(urls).toEqual([
        `POST ${base}/keys`,
        `POST ${base}/key-actions/block`,
        `POST ${base}/key-actions/unblock`,
        `GET ${base}/keys/${PATH}`,
        `GET ${base}/keys/${PATH}`,
      ]);
      for (const url of urls) expect(url).not.toContain("%");
    });
  }

  it("a network id outside the grammar is refused with zero requests on every call", async () => {
    const bad = [
      "did:web:example.com%3A8443:default",
      "did:web:a/b:default",
      "did:key:z6Mk?x=1:default",
      "did:key:z6Mk#frag:default",
      "did:key:z6Mk z:default",
      "did:key:z6Mk:de%66ault",
      "did:key:z6Mk:def/ault",
      "did:key:z6Mk:DE\u202Eault",
    ].map((id) => `urn:tinycloud:encryption:${id}`);
    bad.push("not-a-network", "", `${NETWORK_ID}/keys`, `${NETWORK_ID}\n`);
    for (const networkId of bad) {
      const h = harness(missingNode);
      const options = { networkId };
      const calls = [
        () => h.client.createKey(PATH, options),
        () => h.client.blockKey(PATH, options),
        () => h.client.unblockKey(PATH, options),
        () => h.client.getPublicKey(PATH, options),
        () => h.client.describeKey(PATH, options),
        () => h.client.ensureKey(PATH, options),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({ code: "INVALID_KEY_TARGET" });
      }
      expect(h.requests).toHaveLength(0);
      expect(h.signed).toHaveLength(0);
    }
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
    [403, "deletable_unavailable: x", "DELETABLE_UNAVAILABLE"],
    [409, "key_not_deletable: x", "KEY_NOT_DELETABLE"],
    [400, "key_path_invalid: x", "KEY_PATH_INVALID"],
    [403, "key_unwrap_failed: x", "KEY_UNWRAP_FAILED"],
    [400, "receiver_key_invalid: receiverPublicKey must be a 32-byte X25519 public key", "RECEIVER_KEY_INVALID"],
    [401, "", "NODE_ERROR"],
    [403, "", "NODE_ERROR"],
    [500, "boom", "NODE_ERROR"],
    [403, "unheard_of_code: x", "NODE_ERROR"],
  ];
  for (const [status, body, code] of table) {
    it(`${status} ${body} -> ${code}`, () => {
      expect(mapNodeKeyError(status, body, "ctx").code).toBe(code);
    });
  }

  it("a deleted code maps to KEY_UNAVAILABLE carrying the raw code", () => {
    for (const raw of ["key_deleted"]) {
      const error = mapNodeKeyError(403, `${raw}: gone`, "ctx");
      expect(error.code).toBe("KEY_UNAVAILABLE");
      expect(error.rawState).toBe(raw);
    }
  });

  it("caps the node code kept in nodeCode and echoed in the message at 64 characters", () => {
    const long = "a".repeat(300);
    const error = mapNodeKeyError(403, `${long}: detail`, "ctx");
    expect(error.code).toBe("NODE_ERROR");
    expect(error.nodeCode).toBe("a".repeat(64));
    expect(error.message).not.toContain("a".repeat(65));
    expect(error.status).toBe(403);
  });

  it("an empty body keeps the status and carries no nodeCode", () => {
    for (const status of [401, 403]) {
      const error = mapNodeKeyError(status, "", "ctx");
      expect(error.code).toBe("NODE_ERROR");
      expect(error.status).toBe(status);
      expect(error.nodeCode).toBeUndefined();
      expect(error.message).toContain(String(status));
    }
  });

  it("block and unblock on a missing row map key_not_found to KEY_NOT_FOUND", async () => {
    for (const call of [(c: NamedKeyClient) => c.blockKey(PATH), (c: NamedKeyClient) => c.unblockKey(PATH)]) {
      const h = harness(() => text("key_not_found: no such key", 404));
      await expect(call(h.client)).rejects.toMatchObject({ code: "KEY_NOT_FOUND", status: 404, nodeCode: "key_not_found" });
    }
  });

  it("the public GET has no 404 branch: key_not_found throws, it is not null", async () => {
    const h = harness(() => text("key_not_found: x", 404));
    await expect(h.client.getPublicKey(PATH)).rejects.toMatchObject({ code: "KEY_NOT_FOUND", status: 404 });
    const net = harness(() => text("network_not_found: x", 404));
    await expect(net.client.getPublicKey(PATH)).rejects.toMatchObject({ code: "NETWORK_NOT_FOUND" });
  });
});

describe("envelopes", () => {
  /** Stub node for `/invoke`: unwraps with the key secret and rewraps to the receiver key. */
  const invokeNode = (
    secrets: Record<string, Uint8Array>,
    seen: Recorded[],
    tweak: (response: Record<string, unknown>) => Record<string, unknown> = (r) => r,
  ): Handler => (req) => {
    if (req.url === `${HOST}/invoke`) {
      seen.push(req);
      const body = JSON.parse(req.body!) as Record<string, string>;
      const sym = xor(secrets[body.keyPath!]!, base64Decode(body.encryptedSymmetricKey!));
      const receiver = base64Decode(body.receiverPublicKey!);
      const invocationCid = `cid${/Bearer (\d+)/.exec(req.headers.Authorization!)![1]}`;
      const bodyHash = hexEncode(sha256(utf8Encode(req.body!)));
      return json(tweak({
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
      }));
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
    // The stub wrap is xor(pub, sym); unwrapping with the KEY public bytes recovers a key that decrypts.
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
    const other = "apps/other/key";
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

  it("maps every named-key denial at HTTP 403 on /invoke by its code, not its status", async () => {
    const cases: Array<[string, string]> = [
      ["key_path_invalid", "KEY_PATH_INVALID"],
      ["key_blocked", "KEY_BLOCKED"],
      ["key_not_found", "KEY_NOT_FOUND"],
      ["key_unwrap_failed", "KEY_UNWRAP_FAILED"],
      ["network_not_active", "NETWORK_NOT_ACTIVE"],
    ];
    for (const [nodeCode, code] of cases) {
      const h = harness((req) =>
        req.url === `${HOST}/invoke`
          ? text(`${nodeCode}: denied`, 403)
          : req.url.startsWith(KEYS_URL)
            ? json({ ...descriptor(), state: undefined, kind: undefined })
            : undefined,
      );
      const env = await h.client.encrypt(PATH, utf8Encode("x"));
      await expect(h.client.decrypt(env)).rejects.toMatchObject({ code, status: 403, nodeCode });
    }
  });

  it("an empty-body 401 or 403 on /invoke is NODE_ERROR carrying the status", async () => {
    for (const status of [401, 403]) {
      const h = harness((req) =>
        req.url === `${HOST}/invoke`
          ? text("", status)
          : req.url.startsWith(KEYS_URL)
            ? json({ ...descriptor(), state: undefined, kind: undefined })
            : undefined,
      );
      const env = await h.client.encrypt(PATH, utf8Encode("x"));
      await expect(h.client.decrypt(env)).rejects.toMatchObject({ code: "NODE_ERROR", status });
    }
  });

  it("verifies requestHash against its own invocation CID and body hash", async () => {
    const h = harness(invokeNode({ [PATH]: KEY_PUB }, [], (r) => ({ ...r, requestHash: "0".repeat(64) })));
    const env = await h.client.encrypt(PATH, utf8Encode("x"));
    await expect(h.client.decrypt(env)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a response bound to a different invocation CID", async () => {
    const h = harness(invokeNode({ [PATH]: KEY_PUB }, [], (r) => ({ ...r, invocationCid: "cid-other" })));
    const env = await h.client.encrypt(PATH, utf8Encode("x"));
    await expect(h.client.decrypt(env)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("encrypt takes keyVersion from the key descriptor, never the network, and decrypt requires the response to echo it", async () => {
    const h = harness((req) =>
      req.url === `${KEYS_URL}/${PATH}`
        ? json({ ...descriptor({ keyVersion: 3 }), state: undefined, kind: undefined })
        : undefined,
    );
    const env = await h.client.encrypt(PATH, utf8Encode("x"));
    expect(env.keyVersion).toBe(3);
    // Only /info and the key GET were read: the network descriptor is never consulted.
    expect(h.requests.map((r) => r.url)).toEqual([`${HOST}/info`, `${KEYS_URL}/${PATH}`]);

    const mismatched = harness(
      invokeNode({ [PATH]: KEY_PUB }, [], (r) => ({ ...r, keyVersion: 1 })),
    );
    await expect(mismatched.client.decrypt(env)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("/info caching", () => {
  const infoCount = (rs: Recorded[]) => rs.filter((r) => r.url === `${HOST}/info`).length;

  it("reads /info once per client across calls, and again after an explicit refresh", async () => {
    const h = harness(() => json(descriptor()));
    await h.client.describeKey(PATH);
    await h.client.describeKey(PATH);
    await h.client.createKey(PATH);
    await h.client.getPublicKey(PATH);
    expect(infoCount(h.requests)).toBe(1);
    h.client.refreshNodeInfo();
    await h.client.describeKey(PATH);
    expect(infoCount(h.requests)).toBe(2);
  });

  it("coalesces concurrent first calls into one /info read", async () => {
    const h = harness(() => json(descriptor()));
    await Promise.all([h.client.describeKey(PATH), h.client.describeKey(PATH), h.client.describeKey(PATH)]);
    expect(infoCount(h.requests)).toBe(1);
  });

  it("does not cache a feature-off answer: the retry re-reads and sees an upgraded node", async () => {
    let features = ["sql"];
    const h = harness(() => json(descriptor()), {
      info: () => json({ nodeId: NODE, features }),
    });
    await expect(h.client.ensureKey(PATH)).rejects.toMatchObject({ code: "NAMED_KEYS_UNSUPPORTED" });
    expect(keyRequests(h.requests)).toHaveLength(0);
    features = ["encryption-named-keys-v1"];
    expect((await h.client.ensureKey(PATH)).state).toBe("active");
    expect(infoCount(h.requests)).toBe(2);
  });
});

describe("error messages never carry raw untrusted text", () => {
  const BIDI_OR_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
  const HOSTILE = "evil\u202Enet\u200Bwork";

  it("both fact builders refuse a key resource whose network contains bidi or zero-width characters", () => {
    for (const network of ["evil\u202Enet", "net\u200Bwork"]) {
      const resource = `urn:tinycloud:encryption:${OWNER}:${network}/${PATH}`;
      expect(() =>
        buildKeyAdminFacts({ crypto, targetNode: NODE, keyResource: resource, action: KEY_CREATE_ABILITY, body: {} }),
      ).toThrow(expect.objectContaining({ code: "INVALID_KEY_TARGET" }));
      expect(() => buildKeyDescribeFacts({ targetNode: NODE, keyResource: resource })).toThrow(
        expect.objectContaining({ code: "INVALID_KEY_TARGET" }),
      );
    }
  });

  it("a hostile network in a target is escaped in the message and kept raw only in `input`", async () => {
    const h = harness(() => undefined);
    const networkId = `urn:tinycloud:encryption:${OWNER}:${HOSTILE}`;
    const error = (await h.client.createKey(PATH, { networkId }).catch((e: unknown) => e)) as NamedKeyError;
    expect(error).toBeInstanceOf(NamedKeyError);
    expect(error.code).toBe("INVALID_KEY_TARGET");
    expect(error.message).not.toMatch(BIDI_OR_ZERO_WIDTH);
    expect(error.input).toContain("\u202E");
    expect(h.requests).toHaveLength(0);
  });

  it("a hostile resource passed to the target check is escaped", () => {
    const resource = `${NETWORK_ID}/apps/ev\u202Eil\u200Bx`;
    let thrown: unknown;
    try {
      buildKeyAdminFacts({ crypto, targetNode: NODE, keyResource: resource, action: KEY_CREATE_ABILITY, body: {} });
    } catch (e) {
      thrown = e;
    }
    const error = thrown as NamedKeyError;
    expect(error.code).toBe("INVALID_KEY_TARGET");
    expect(error.message).not.toMatch(BIDI_OR_ZERO_WIDTH);
    expect(error.message).toContain("\\u{202E}");
    expect(error.message).toContain("\\u{200B}");
    expect(error.input).toBe(resource);
  });

  it("hostile node-supplied state and kind are escaped in the message and raw in their own fields", async () => {
    const state = `act\u202Eive\u200B`;
    const h = harness(() => json(descriptor({ state })));
    const unavailable = (await h.client.ensureKey(PATH).catch((e: unknown) => e)) as NamedKeyError;
    expect(unavailable.code).toBe("KEY_UNAVAILABLE");
    expect(unavailable.message).not.toMatch(BIDI_OR_ZERO_WIDTH);
    expect(unavailable.message).toContain("\\u{202E}");
    expect(unavailable.rawState).toBe(state);

    const k = harness(() => json(descriptor({ kind: HOSTILE })));
    const mismatch = (await k.client.ensureKey(PATH).catch((e: unknown) => e)) as NamedKeyError;
    expect(mismatch.code).toBe("KEY_KIND_MISMATCH");
    expect(mismatch.message).not.toMatch(BIDI_OR_ZERO_WIDTH);
    expect(mismatch.kind).toBe(HOSTILE);
  });

  it("a hostile envelope network is rejected without echoing it", async () => {
    const h = harness(() => undefined);
    const envelope = {
      v: 2,
      networkId: `urn:tinycloud:encryption:${OWNER}:${HOSTILE}`,
      keyPath: PATH,
      alg: "a",
      keyVersion: 1,
      encryptedSymmetricKey: "AA==",
      encryptedSymmetricKeyHash: canonicalHashHex(sha256, "AA=="),
      ciphertext: "AA==",
    } as unknown as NamedKeyEnvelope;
    const error = (await h.client.decrypt(envelope).catch((e: unknown) => e)) as NamedKeyError;
    expect(error.code).toBe("INVALID_ENVELOPE");
    expect(error.message).not.toMatch(BIDI_OR_ZERO_WIDTH);
    expect(h.requests).toHaveLength(0);
  });

  it("echoed values are capped at 120 characters", async () => {
    const state = "s".repeat(500);
    const h = harness(() => json(descriptor({ state })));
    const error = (await h.client.ensureKey(PATH).catch((e: unknown) => e)) as NamedKeyError;
    expect(error.message).toContain(`${"s".repeat(120)}...`);
    expect(error.message).not.toContain("s".repeat(121));
    expect(error.rawState).toBe(state);
  });

  it("the read-back failure message caps the echoed key path at 120 characters", async () => {
    const seg = "a".repeat(60);
    const longPath = [seg, seg, seg, seg].join("/");
    const steps = [
      () => text("key_not_found: x", 404),
      () => text("key_exists: path exists", 409),
      () => text("key_not_found: x", 404),
    ];
    let i = 0;
    const h = harness(() => steps[i++]!());
    const error = (await h.client.ensureKey(longPath).catch((e: unknown) => e)) as NamedKeyError;
    expect(error.code).toBe("KEY_NOT_FOUND");
    expect(error.message).toContain(`${longPath.slice(0, 120)}...`);
    expect(error.message).not.toContain(longPath.slice(0, 121));
  });
});

describe("create body `deletable` (node 1.22.0 contract)", () => {
  const APP_PATH = "apps/tinychat/session";

  it("sends deletable: true exactly under apps/ and never a shreddable field", async () => {
    for (const [path, expected] of [
      [APP_PATH, '{"deletable":true,"keyPath":"apps/tinychat/session"}'],
      [PATH, '{"deletable":false,"keyPath":"secrets/software-factory"}'],
      ["apps-x/y", '{"deletable":false,"keyPath":"apps-x/y"}'],
    ] as const) {
      const h = harness(() => json(descriptor({ keyPath: path })));
      await h.client.createKey(path);
      const [req] = keyRequests(h.requests);
      expect(req!.body).toBe(expected);
      expect(req!.body).not.toContain("shreddable");
      expect(h.signed[0]!.facts.bodyHash).toBe(canonicalHashHex(sha256, JSON.parse(expected)));
    }
  });

  it("maps deletable_unavailable and key_not_deletable by code, at any status", () => {
    for (const status of [400, 403, 409]) {
      expect(mapNodeKeyError(status, "deletable_unavailable: not enabled", "ctx")).toMatchObject({
        code: "DELETABLE_UNAVAILABLE",
        status,
        nodeCode: "deletable_unavailable",
      });
    }
    expect(mapNodeKeyError(409, "key_not_deletable: deterministic key", "ctx")).toMatchObject({
      code: "KEY_NOT_DELETABLE",
      status: 409,
      nodeCode: "key_not_deletable",
    });
  });

  it("a node that refuses deletable: true surfaces DELETABLE_UNAVAILABLE from createKey and ensureKey", async () => {
    const refuse = (req: Recorded) =>
      req.method === "POST" ? text("deletable_unavailable: app key deletion is not enabled", 403) : undefined;
    const direct = harness(refuse);
    await expect(direct.client.createKey(APP_PATH)).rejects.toMatchObject({ code: "DELETABLE_UNAVAILABLE" });

    const steps = [() => text("key_not_found: x", 404), () => text("deletable_unavailable: x", 403)];
    let i = 0;
    const ensured = harness(() => steps[i++]!());
    await expect(ensured.client.ensureKey(APP_PATH)).rejects.toMatchObject({ code: "DELETABLE_UNAVAILABLE" });
  });

  it("shreddable_* and key_retired are not mapped: they surface as NODE_ERROR", () => {
    for (const body of [
      "shreddable_unavailable: x",
      "shreddable_requires_paid_tier: x",
      "key_retired: x",
    ]) {
      expect(mapNodeKeyError(403, body, "ctx").code).toBe("NODE_ERROR");
    }
    expect(mapNodeKeyError(403, "key_deleted: gone", "ctx")).toMatchObject({
      code: "KEY_UNAVAILABLE",
      rawState: "key_deleted",
    });
  });

  it("a public GET under apps/ is KEY_NOT_FOUND (the node answers 404 even for an existing key)", async () => {
    const h = harness(() => text("key_not_found: no key exists at this path", 404));
    await expect(h.client.getPublicKey(APP_PATH)).rejects.toMatchObject({ code: "KEY_NOT_FOUND", status: 404 });
  });

  it("encrypt under apps/ reads the public key through an authenticated decrypt describe, never the public GET", async () => {
    const h = harness((req) =>
      req.headers.Authorization === undefined
        ? text("key_not_found: no key exists at this path", 404)
        : json(descriptor({ keyPath: APP_PATH, kind: "deletable" })),
    );
    const env = await h.client.encrypt(APP_PATH, utf8Encode("x"));
    expect(env.keyPath).toBe(APP_PATH);
    const sym = xor(KEY_PUB, base64Decode(env.encryptedSymmetricKey));
    expect(xor(sym, base64Decode(env.ciphertext))).toEqual(utf8Encode("x"));
    expect(keyRequests(h.requests).map((r) => r.method)).toEqual(["GET"]);
    expect(keyRequests(h.requests)[0]!.headers.Authorization).toBeDefined();
    expect(h.signed).toHaveLength(1);
    expect(h.signed[0]!.resource).toBe(formatKeyResource(NETWORK_ID, APP_PATH));
    expect(h.signed[0]!.action).toBe(DECRYPT_ACTION);
  });

  it("encrypt to a missing key under apps/ is KEY_NOT_FOUND and creates nothing", async () => {
    const h = harness(() => text("key_not_found: no key exists at this path", 404));
    await expect(h.client.encrypt(APP_PATH, utf8Encode("x"))).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
    expect(keyRequests(h.requests).every((r) => r.method === "GET")).toBe(true);
  });

  it("ensureKey expects kind deletable under apps/ and deterministic elsewhere", async () => {
    const ok = harness(() => json(descriptor({ keyPath: APP_PATH, kind: "deletable" })));
    await expect(ok.client.ensureKey(APP_PATH)).resolves.toMatchObject({ kind: "deletable", keyPath: APP_PATH });

    const wrongApp = harness(() => json(descriptor({ keyPath: APP_PATH, kind: "deterministic" })));
    await expect(wrongApp.client.ensureKey(APP_PATH)).rejects.toMatchObject({ code: "KEY_KIND_MISMATCH", kind: "deterministic" });

    const wrongSecret = harness(() => json(descriptor({ kind: "deletable" })));
    await expect(wrongSecret.client.ensureKey(PATH)).rejects.toMatchObject({ code: "KEY_KIND_MISMATCH", kind: "deletable" });
  });
});

describe("node error codes are matched as own keys only", () => {
  it("`constructor`, `__proto__` and `toString` bodies are NODE_ERROR with no mapped code", () => {
    for (const body of ["constructor: x", "__proto__: x", "toString: x", "hasOwnProperty: x", "valueOf: x"]) {
      for (const status of [400, 403, 404]) {
        const error = mapNodeKeyError(status, body, "ctx");
        expect(error.code).toBe("NODE_ERROR");
        expect(typeof error.code).toBe("string");
        expect(error.status).toBe(status);
      }
    }
  });
});
