import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_LOCAL_NODE_URL,
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  canonicalLocationPayload,
  createInMemoryLocalNodeIdentityStore,
  discoverLocalTinyCloudNode,
  httpUrlToMultiaddr,
  locationPayloadForRecord,
  multiaddrToHttpUrl,
  resolveCloudLocation,
  resolveTinyCloudHosts,
  signLocationRecord,
  validateLocationRecord,
  verifyLocationRecord,
  type LocationRecordPayload,
} from "./location";

const TEST_SUBJECT =
  "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
const NODE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_NODE_DID = "did:key:z6MkfDifferentNodeEntirely11111111111111111111";

interface FakeNodeRoute {
  healthy?: boolean;
  nodeDid?: string;
}

/**
 * Mock fetch serving /healthz + /info per URL prefix. Unrouted URLs get
 * `onMiss` (default: connection-refused-style TypeError, like a dead port).
 */
function fakeFetch(
  routes: Record<string, FakeNodeRoute>,
  requests: string[] = [],
  onMiss: (url: string) => Response | Error = () =>
    new TypeError("fetch failed: connection refused"),
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    for (const [prefix, route] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      const healthy = route.healthy ?? true;
      if (url === `${prefix}/healthz`) {
        return new Response(healthy ? "ok" : "no", {
          status: healthy ? 200 : 503,
        });
      }
      if (url === `${prefix}/info`) {
        return Response.json(
          route.nodeDid !== undefined ? { nodeId: route.nodeDid } : {},
        );
      }
    }
    const miss = onMiss(url);
    if (miss instanceof Error) throw miss;
    return miss;
  }) as typeof fetch;
}

describe("location records", () => {
  it("signs and verifies did:pkh records", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const payload: LocationRecordPayload = {
      version: 1,
      subject: `did:pkh:eip155:1:${account.address}`,
      multiaddrs: ["/dns4/node.tinycloud.xyz/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
    };

    const record = await signLocationRecord(payload, {
      type: "did:pkh",
      signMessage: (message) => account.signMessage({ message }),
    });

    expect(validateLocationRecord(record)).toEqual(record);
    expect(await verifyLocationRecord(record)).toBe(true);
    expect(
      canonicalLocationPayload(locationPayloadForRecord(record)),
    ).not.toContain("signature");
  });

  it("signs and verifies did:key records", async () => {
    const privateKey = new Uint8Array(32).fill(9);
    const publicKey = ed25519.getPublicKey(privateKey);
    const subject = `did:key:${bases.base58btc.encode(
      Uint8Array.of(0xed, 0x01, ...publicKey),
    )}`;
    const payload: LocationRecordPayload = {
      version: 1,
      subject,
      multiaddrs: ["/dns4/node.tinycloud.xyz/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
    };

    const record = await signLocationRecord(payload, {
      type: "did:key",
      signBytes: async (bytes) => ed25519.sign(bytes, privateKey),
    });

    expect(await verifyLocationRecord(record)).toBe(true);
  });

  it("converts http URLs and multiaddrs", () => {
    const ma = httpUrlToMultiaddr("https://node.tinycloud.xyz/");
    expect(ma).toBe("/dns/node.tinycloud.xyz/tcp/443/tls/http");
    expect(multiaddrToHttpUrl(ma)).toBe("https://node.tinycloud.xyz");
  });
});

describe("resolveTinyCloudHosts", () => {
  it("uses the default registry and hosted node fallback", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const requests: string[] = [];

    const resolved = await resolveTinyCloudHosts(subject, {
      autoDiscoverLocalNode: false,
      fetch: async (input) => {
        requests.push(String(input));
        return new Response("{}", { status: 404 });
      },
    });

    expect(requests).toEqual([
      `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/${encodeURIComponent(subject)}`,
    ]);
    expect(resolved.location.source).toBe("fallback");
    expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  });

  it("lets explicit hosts override registry and fallback defaults", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveTinyCloudHosts(subject, {
      explicitHosts: ["https://local.node.test"],
      fetch: async () => new Response("{}", { status: 404 }),
    });

    expect(resolved.location.source).toBe("explicit");
    expect(resolved.hosts).toEqual(["https://local.node.test"]);
  });

  it("allows a custom registry URL", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const registryUrl = "https://registry.example";
    const record = {
      version: 1,
      subject,
      multiaddrs: ["/dns4/registry.node.test/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
      signature: "test-signature",
    };
    const requests: string[] = [];

    const resolved = await resolveTinyCloudHosts(subject, {
      registryUrl,
      verifyRecords: false,
      autoDiscoverLocalNode: false,
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({ record });
      },
    });

    expect(requests).toEqual([
      `${registryUrl}/v1/locations/${encodeURIComponent(subject)}`,
    ]);
    expect(resolved.location.source).toBe("centralized");
    expect(resolved.hosts).toEqual(["https://registry.node.test"]);
  });
});

describe("resolveCloudLocation", () => {
  it("queries sources concurrently but ranks explicit first", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveCloudLocation(subject, {
      explicitMultiaddrs: ["/dns4/explicit.tinycloud.xyz/tcp/443/https"],
      blockchain: async (requestedSubject) => {
        expect(requestedSubject).toBe(subject);
        return ["/dns4/chain.tinycloud.xyz/tcp/443/https"];
      },
      fallbackMultiaddrs: ["/dns4/fallback.tinycloud.xyz/tcp/443/https"],
    });

    expect(resolved.source).toBe("explicit");
    expect(resolved.multiaddrs).toEqual([
      "/dns4/explicit.tinycloud.xyz/tcp/443/https",
    ]);
    expect(resolved.attempts.map((attempt) => attempt.source)).toEqual([
      "explicit",
      "blockchain",
      "centralized",
      "fallback",
    ]);
  });

  it("falls through when a higher-priority source fails", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveCloudLocation(subject, {
      blockchain: async () => {
        throw new Error("chain unavailable");
      },
      fallbackMultiaddrs: ["/dns4/fallback.tinycloud.xyz/tcp/443/https"],
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.attempts[1].error?.message).toBe("chain unavailable");
  });
});

describe("discoverLocalTinyCloudNode candidate ordering", () => {
  it("adopts the default loopback candidate first and pins its DID", async () => {
    const requests: string[] = [];
    const store = createInMemoryLocalNodeIdentityStore();
    const discovered = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }, requests),
      identityStore: store,
    });

    expect(discovered).toEqual({
      source: "local-loopback",
      url: DEFAULT_LOCAL_NODE_URL,
      nodeDid: NODE_DID,
    });
    expect(requests).toEqual([
      `${DEFAULT_LOCAL_NODE_URL}/healthz`,
      `${DEFAULT_LOCAL_NODE_URL}/info`,
    ]);
    expect(await store.get(DEFAULT_LOCAL_NODE_URL)).toBe(NODE_DID);
  });

  it("probes loopback before the explicit local-link candidate", async () => {
    const linkUrl = "https://myname.local.tinycloud.link";
    const requests: string[] = [];
    const discovered = await discoverLocalTinyCloudNode({
      localLinkName: "myname",
      fetch: fakeFetch({ [linkUrl]: { nodeDid: NODE_DID } }, requests),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(discovered).toEqual({
      source: "local-link",
      url: linkUrl,
      nodeDid: NODE_DID,
    });
    // Loopback was tried (and refused) before the link candidate.
    expect(requests).toEqual([
      `${DEFAULT_LOCAL_NODE_URL}/healthz`,
      `${linkUrl}/healthz`,
      `${linkUrl}/info`,
    ]);
  });

  it("respects a custom localNodeUrl", async () => {
    const customUrl = "http://127.0.0.1:9111";
    const discovered = await discoverLocalTinyCloudNode({
      localNodeUrl: customUrl,
      fetch: fakeFetch({ [customUrl]: { nodeDid: NODE_DID } }),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(discovered?.url).toBe(customUrl);
    expect(discovered?.source).toBe("local-loopback");
  });

  it("only consults the registry after the static candidates fail", async () => {
    const requests: string[] = [];
    const discovered = await discoverLocalTinyCloudNode({
      subject: TEST_SUBJECT,
      registryUrl: "https://registry.example",
      verifyRecords: false,
      fetch: fakeFetch({}, requests, (url) =>
        url.startsWith("https://registry.example")
          ? new Response("{}", { status: 404 })
          : new TypeError("fetch failed: connection refused"),
      ),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(discovered).toBeNull();
    expect(requests).toEqual([
      `${DEFAULT_LOCAL_NODE_URL}/healthz`,
      `https://registry.example/v1/locations/${encodeURIComponent(TEST_SUBJECT)}`,
    ]);
  });
});

describe("discoverLocalTinyCloudNode probe failures", () => {
  const failureModes: Array<[string, Error]> = [
    ["connection refused", new TypeError("fetch failed: connection refused")],
    ["timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["nxdomain", new TypeError("fetch failed: getaddrinfo ENOTFOUND")],
  ];

  for (const [label, error] of failureModes) {
    it(`silently returns null on ${label}`, async () => {
      const discovered = await discoverLocalTinyCloudNode({
        fetch: fakeFetch({}, [], () => error),
        identityStore: createInMemoryLocalNodeIdentityStore(),
      });
      expect(discovered).toBeNull();
    });
  }

  it("skips a candidate whose /healthz is unhealthy", async () => {
    const discovered = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { healthy: false } }),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });
    expect(discovered).toBeNull();
  });

  it("skips a healthy candidate whose /info reports no nodeId", async () => {
    const store = createInMemoryLocalNodeIdentityStore();
    const discovered = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: {} }),
      identityStore: store,
    });
    expect(discovered).toBeNull();
    expect(await store.get(DEFAULT_LOCAL_NODE_URL)).toBeUndefined();
  });
});

describe("discoverLocalTinyCloudNode identity pinning", () => {
  it("adopts a node whose DID matches expectedNodeDid", async () => {
    const discovered = await discoverLocalTinyCloudNode({
      expectedNodeDid: NODE_DID,
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });
    expect(discovered?.nodeDid).toBe(NODE_DID);
  });

  it("rejects a node whose DID does not match expectedNodeDid", async () => {
    const store = createInMemoryLocalNodeIdentityStore();
    const discovered = await discoverLocalTinyCloudNode({
      expectedNodeDid: NODE_DID,
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: OTHER_NODE_DID } }),
      identityStore: store,
    });
    expect(discovered).toBeNull();
    // A rejected node must never overwrite expectations.
    expect(await store.get(DEFAULT_LOCAL_NODE_URL)).toBeUndefined();
  });

  it("pins on first use, then rejects a later DID change (TOFU)", async () => {
    const store = createInMemoryLocalNodeIdentityStore();

    const first = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }),
      identityStore: store,
    });
    expect(first?.nodeDid).toBe(NODE_DID);
    expect(await store.get(DEFAULT_LOCAL_NODE_URL)).toBe(NODE_DID);

    const second = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: OTHER_NODE_DID } }),
      identityStore: store,
    });
    expect(second).toBeNull();
    // The original pin survives the mismatch.
    expect(await store.get(DEFAULT_LOCAL_NODE_URL)).toBe(NODE_DID);
  });

  it("accepts a returning node that matches its existing pin", async () => {
    const store = createInMemoryLocalNodeIdentityStore();
    await store.set(DEFAULT_LOCAL_NODE_URL, NODE_DID);

    const discovered = await discoverLocalTinyCloudNode({
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }),
      identityStore: store,
    });
    expect(discovered?.nodeDid).toBe(NODE_DID);
  });

  it("lets expectedNodeDid override a stale pin", async () => {
    const store = createInMemoryLocalNodeIdentityStore();
    await store.set(DEFAULT_LOCAL_NODE_URL, OTHER_NODE_DID);

    const discovered = await discoverLocalTinyCloudNode({
      expectedNodeDid: NODE_DID,
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }),
      identityStore: store,
    });
    expect(discovered?.nodeDid).toBe(NODE_DID);
  });
});

describe("discoverLocalTinyCloudNode local-link registry extraction", () => {
  const linkUrl = "https://mynode.local.tinycloud.link";
  const record = {
    version: 1,
    subject: TEST_SUBJECT,
    multiaddrs: [
      "/dns/node.tinycloud.xyz/tcp/443/tls/http",
      "/dns/mynode.local.tinycloud.link/tcp/443/tls/http",
      // http (not https) local-link entries must be ignored.
      "/dns/insecure.local.tinycloud.link/tcp/80/http",
    ],
    updated_at: "2026-04-28T16:00:00.000Z",
    sequence: 1,
    signature: "test-signature",
  };

  it("extracts and probes https *.local.tinycloud.link multiaddrs only", async () => {
    const requests: string[] = [];
    const discovered = await discoverLocalTinyCloudNode({
      subject: TEST_SUBJECT,
      registryUrl: "https://registry.example",
      verifyRecords: false,
      fetch: fakeFetch({ [linkUrl]: { nodeDid: NODE_DID } }, requests, (url) =>
        url.startsWith("https://registry.example")
          ? Response.json({ record })
          : new TypeError("fetch failed: connection refused"),
      ),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(discovered).toEqual({
      source: "local-link",
      url: linkUrl,
      nodeDid: NODE_DID,
    });
    // Hosted node.tinycloud.xyz and the insecure link entry were never probed.
    expect(requests).toEqual([
      `${DEFAULT_LOCAL_NODE_URL}/healthz`,
      `https://registry.example/v1/locations/${encodeURIComponent(TEST_SUBJECT)}`,
      `${linkUrl}/healthz`,
      `${linkUrl}/info`,
    ]);
  });

  it("skips registry local-link candidates when the record signature is invalid", async () => {
    const discovered = await discoverLocalTinyCloudNode({
      subject: TEST_SUBJECT,
      registryUrl: "https://registry.example",
      // verifyRecords defaults to true; "test-signature" cannot verify.
      fetch: fakeFetch({ [linkUrl]: { nodeDid: NODE_DID } }, [], (url) =>
        url.startsWith("https://registry.example")
          ? Response.json({ record })
          : new TypeError("fetch failed: connection refused"),
      ),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });
    expect(discovered).toBeNull();
  });

  it("skips the registry lookup entirely without a subject", async () => {
    const requests: string[] = [];
    const discovered = await discoverLocalTinyCloudNode({
      registryUrl: "https://registry.example",
      fetch: fakeFetch({}, requests),
      identityStore: createInMemoryLocalNodeIdentityStore(),
    });
    expect(discovered).toBeNull();
    expect(requests).toEqual([`${DEFAULT_LOCAL_NODE_URL}/healthz`]);
  });
});

describe("resolveTinyCloudHosts local discovery integration", () => {
  it("prefers a verified local node over registry and fallback", async () => {
    const requests: string[] = [];
    const resolved = await resolveTinyCloudHosts(TEST_SUBJECT, {
      fetch: fakeFetch({ [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } }, requests),
      localNodeIdentityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(resolved.hosts).toEqual([DEFAULT_LOCAL_NODE_URL]);
    expect(resolved.location.source).toBe("local-loopback");
    // The registry was never consulted once the local node won.
    expect(
      requests.some((url) =>
        url.startsWith(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL),
      ),
    ).toBe(false);
  });

  it("falls back to registry resolution when every local probe fails", async () => {
    const requests: string[] = [];
    const resolved = await resolveTinyCloudHosts(TEST_SUBJECT, {
      fetch: fakeFetch({}, requests, (url) =>
        url.startsWith(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL)
          ? new Response("{}", { status: 404 })
          : new TypeError("fetch failed: connection refused"),
      ),
      localNodeIdentityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(resolved.location.source).toBe("fallback");
    expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
    expect(requests[0]).toBe(`${DEFAULT_LOCAL_NODE_URL}/healthz`);
  });

  it("falls back when the local node fails identity verification", async () => {
    const resolved = await resolveTinyCloudHosts(TEST_SUBJECT, {
      expectedNodeDid: NODE_DID,
      fetch: fakeFetch(
        { [DEFAULT_LOCAL_NODE_URL]: { nodeDid: OTHER_NODE_DID } },
        [],
        (url) =>
          url.startsWith(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL)
            ? new Response("{}", { status: 404 })
            : new TypeError("fetch failed: connection refused"),
      ),
      localNodeIdentityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(resolved.location.source).toBe("fallback");
    expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  });

  it("autoDiscoverLocalNode: false restores legacy resolution (no probes)", async () => {
    const requests: string[] = [];
    const resolved = await resolveTinyCloudHosts(TEST_SUBJECT, {
      autoDiscoverLocalNode: false,
      fetch: fakeFetch(
        { [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } },
        requests,
        () => new Response("{}", { status: 404 }),
      ),
      localNodeIdentityStore: createInMemoryLocalNodeIdentityStore(),
    });

    // Even with a healthy local node listening, opt-out never touches it.
    expect(requests).toEqual([
      `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/${encodeURIComponent(TEST_SUBJECT)}`,
    ]);
    expect(resolved.location.source).toBe("fallback");
    expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  });

  it("explicit hosts skip local discovery entirely", async () => {
    const requests: string[] = [];
    const resolved = await resolveTinyCloudHosts(TEST_SUBJECT, {
      explicitHosts: ["https://mynode.example"],
      fetch: fakeFetch(
        { [DEFAULT_LOCAL_NODE_URL]: { nodeDid: NODE_DID } },
        requests,
      ),
      localNodeIdentityStore: createInMemoryLocalNodeIdentityStore(),
    });

    expect(resolved.location.source).toBe("explicit");
    expect(resolved.hosts).toEqual(["https://mynode.example"]);
    // Sources are still queried concurrently (pre-TC-106 behavior), but no
    // local candidate is ever probed.
    expect(requests.some((url) => url.includes("/healthz"))).toBe(false);
    expect(requests.some((url) => url.includes("127.0.0.1"))).toBe(false);
  });
});
