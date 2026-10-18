import { describe, expect, it, spyOn } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import type * as LocationModule from "./location";

import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  signLocationRecord,
  type WebStorageLike,
} from "./location";
import {
  DEFAULT_NEW_USER_HOST,
  NodeNotFoundError,
  NodeRegistryEntryExistsError,
  RegistryUnavailableError,
  assertSpaceCreationAllowed,
  createInMemoryRegistrySequenceStore,
  createLocalStorageRegistrySequenceStore,
  lookupOwnerRegistryVerdict,
  registryOwnerSubjectV1,
  resolveFailClosedTinyCloudHosts,
  resolveOwnerHosts,
  type NodeNotFoundContext,
} from "./registry-policy";
import {
  REGISTRY_LOOKUP_MAX_BODY_BYTES,
  REGISTRY_NOT_FOUND_BODY,
  RegistryLookupInputError,
  type RegistryVerdict,
} from "./registry-verdict";

const REGISTRY = "https://registry.test";
// Test-only key, also used by location.test.ts.
const owner = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SUBJECT = registryOwnerSubjectV1(owner.address);
const LOOKUP_URL = `${REGISTRY}/v1/locations/${encodeURIComponent(SUBJECT)}`;

async function recordBody(multiaddrs: string[], sequence: number): Promise<string> {
  const record = await signLocationRecord(
    {
      version: 1,
      subject: SUBJECT,
      multiaddrs,
      updated_at: "2026-10-18T00:00:00.000Z",
      sequence,
    },
    { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) },
  );
  return JSON.stringify({ record });
}

const notFound = (): Response => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });

/** A registry that answers each lookup with the next response; every request is recorded. */
function registry(
  answers: Array<() => Response | Promise<Response>>,
  requests: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    requests.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request: ${String(input)}`);
    return next();
  }) as typeof fetch;
}

function memoryStorage(initial: Record<string, string> = {}): WebStorageLike {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function unavailableReason(verdict: RegistryVerdict): string | undefined {
  return verdict.status === "unavailable" ? verdict.reason : undefined;
}

describe("registryOwnerSubjectV1", () => {
  it("keys on the checksummed signer address and the configured chain only", () => {
    expect(registryOwnerSubjectV1(owner.address.toLowerCase())).toBe(
      `did:pkh:eip155:1:${owner.address}`,
    );
    expect(registryOwnerSubjectV1(owner.address, 8453)).toBe(
      `did:pkh:eip155:8453:${owner.address}`,
    );
  });
});

describe("resolveOwnerHosts", () => {
  it("reads the registry's not-found as unregistered and remembers nothing", async () => {
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const requests: string[] = [];
    const verdict = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY,
      sequenceStore,
      fetch: registry([notFound], requests),
    });

    expect(verdict).toEqual({ status: "unregistered", subject: SUBJECT, source: "offchain", hosts: [] });
    expect(requests).toEqual([LOOKUP_URL]);
    expect(await sequenceStore.get(SUBJECT)).toBeUndefined();
  });

  it("remembers a registered owner: a later not-found or older record is unavailable", async () => {
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const body5 = await recordBody(["/dns4/my.node.example/tcp/443/https"], 5);
    const body4 = await recordBody(["/dns4/old.node.example/tcp/443/https"], 4);
    const fetchFn = registry([
      () => new Response(body5),
      notFound,
      () => new Response(body4),
      () => new Response(body5),
    ]);
    const lookup = () => resolveOwnerHosts(SUBJECT, { registryUrl: REGISTRY, sequenceStore, fetch: fetchFn });

    const first = await lookup();
    expect(first.status).toBe("registered");
    expect(first.hosts).toEqual([{ urls: ["https://my.node.example"], source: "offchain" }]);
    expect(await sequenceStore.get(SUBJECT)).toBe(5);

    expect(unavailableReason(await lookup())).toBe("not-found-after-registered");
    expect(unavailableReason(await lookup())).toBe("rollback");
    expect((await lookup()).status).toBe("registered");
  });

  it.each([
    ["a refused connection", () => Promise.reject(new TypeError("fetch failed")), "network-error"],
    ["a 503", () => new Response("down", { status: 503 }), "http-status"],
    ["a 404 that is not the registry's", () => new Response("<html>not found</html>", { status: 404 }), "malformed-response"],
    [
      "a declared oversize body",
      () => new Response("{}", { headers: { "content-length": String(REGISTRY_LOOKUP_MAX_BODY_BYTES + 1) } }),
      "oversize-response",
    ],
    ["a streamed oversize body", () => new Response(" ".repeat(REGISTRY_LOOKUP_MAX_BODY_BYTES + 1)), "oversize-response"],
    ["a body that is not UTF-8", () => new Response(Uint8Array.of(0xff, 0xfe), { status: 404 }), "malformed-response"],
  ] as const)("fails closed on %s", async (_label, answer, reason) => {
    const verdict = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY,
      fetch: registry([answer]),
    });
    expect(unavailableReason(verdict)).toBe(reason);
  });

  it("fails closed when the registry does not answer within the budget", async () => {
    const verdict = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY,
      timeoutMs: 20,
      fetch: registry([() => new Promise<Response>(() => {})]),
    });
    expect(unavailableReason(verdict)).toBe("timeout");
  });

  it.each([
    ["a lowercase address", `did:pkh:eip155:1:${owner.address.toLowerCase()}`],
    ["a did:key longer than an Ed25519 identifier", `did:key:z${"6".repeat(48)}`],
    ["an unbounded subject", `did:key:z${"1".repeat(32_000)}`],
  ])("rejects %s before any request", async (_label, subject) => {
    const requests: string[] = [];
    await expect(
      resolveOwnerHosts(subject, { registryUrl: REGISTRY, fetch: registry([notFound], requests) }),
    ).rejects.toBeInstanceOf(RegistryLookupInputError);
    expect(requests).toEqual([]);
  });
});

describe("createLocalStorageRegistrySequenceStore", () => {
  it("keeps a registration across store instances on the same storage", async () => {
    const storage = memoryStorage();
    const body = await recordBody(["/dns4/my.node.example/tcp/443/https"], 2);
    await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY,
      sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      fetch: registry([() => new Response(body)]),
    });

    const reloaded = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY,
      sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      fetch: registry([notFound]),
    });
    expect(unavailableReason(reloaded)).toBe("not-found-after-registered");
  });

  it("fails closed on corrupt storage instead of forgetting registrations", async () => {
    const store = createLocalStorageRegistrySequenceStore(
      memoryStorage({ "tinycloud.registrySequences.v1": "{not json" }),
    );
    const requests: string[] = [];
    const lookup = lookupOwnerRegistryVerdict(SUBJECT, {
      registryUrl: REGISTRY,
      sequenceStore: store,
      fetch: registry([notFound], requests),
    });
    await expect(lookup).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(requests).toEqual([]);
  });
});

describe("resolveFailClosedTinyCloudHosts", () => {
  const base = { registryUrl: REGISTRY, autoDiscoverLocalNode: false } as const;

  it("routes a registered owner to the record's hosts in order", async () => {
    const requests: string[] = [];
    const body = await recordBody(
      ["/dns4/a.node.example/tcp/443/https", "/dns4/b.node.example/tcp/8443/https"],
      1,
    );
    const resolved = await resolveFailClosedTinyCloudHosts(owner.address.toLowerCase(), {
      ...base,
      fetch: registry([() => new Response(body)], requests),
    });

    expect(resolved.hosts).toEqual(["https://a.node.example", "https://b.node.example:8443"]);
    expect(resolved.verdict?.status).toBe("registered");
    expect(requests).toEqual([LOOKUP_URL]);
  });

  it("routes only unregistered owners to newUserHost", async () => {
    const byDefault = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([notFound]),
    });
    expect(byDefault.hosts).toEqual([DEFAULT_NEW_USER_HOST]);

    const configured = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      newUserHost: "https://new-users.example/",
      fetch: registry([notFound]),
    });
    expect(configured.hosts).toEqual(["https://new-users.example"]);

    const refused = resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      newUserHost: null,
      fetch: registry([notFound]),
    });
    await expect(refused).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("never routes a registered owner without a usable host anywhere else", async () => {
    const requests: string[] = [];
    const tombstone = await recordBody([], 3);
    const error = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([() => new Response(tombstone)], requests),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NodeNotFoundError);
    expect(error).toMatchObject({ code: "node_not_found", verdict: { status: "registered" } });
    expect(requests).toEqual([LOOKUP_URL]);
  });

  it("treats an unreachable or missing registry as unavailable, not as a new user", async () => {
    const down = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([() => new Response("down", { status: 502 })]),
    }).catch((caught: unknown) => caught);
    expect(down).toBeInstanceOf(RegistryUnavailableError);
    expect(down).toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });

    const requests: string[] = [];
    const none = resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      registryUrl: null,
      fetch: registry([notFound], requests),
    });
    await expect(none).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(requests).toEqual([]);
  });

  it("lets onNodeNotFound retry the lookup", async () => {
    const contexts: NodeNotFoundContext[] = [];
    const resolved = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([() => new Response("down", { status: 503 }), notFound]),
      onNodeNotFound: (context) => {
        contexts.push(context);
        return { action: "retry" };
      },
    });

    expect(resolved.hosts).toEqual([DEFAULT_NEW_USER_HOST]);
    expect(contexts.map((context) => context.attempt)).toEqual([1]);
    expect(contexts[0]!.error).toBeInstanceOf(RegistryUnavailableError);
  });

  it("lets onNodeNotFound pick a secure host for the session, keeping the verdict", async () => {
    const resolved = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([() => new Response("down", { status: 503 })]),
      onNodeNotFound: () => ({ action: "use-host", host: "https://my.node.example" }),
    });
    expect(resolved.hosts).toEqual(["https://my.node.example"]);
    expect(resolved.verdict?.status).toBe("unavailable");

    const insecure = resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      fetch: registry([() => new Response("down", { status: 503 })]),
      onNodeNotFound: () => ({ action: "use-host", host: "http://my.node.example" }),
    });
    await expect(insecure).rejects.toThrow("must use HTTPS");
  });

  it("lets onNodeNotFound abort with the original error", async () => {
    let reported: unknown;
    const error = await resolveFailClosedTinyCloudHosts(owner.address, {
      ...base,
      newUserHost: null,
      fetch: registry([notFound]),
      onNodeNotFound: ({ error: failure }) => {
        reported = failure;
        return { action: "abort" };
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NodeNotFoundError);
    expect(error).toBe(reported);
  });
});

describe("assertSpaceCreationAllowed", () => {
  const listed: RegistryVerdict = {
    status: "registered",
    subject: SUBJECT,
    source: "offchain",
    sequence: 1,
    hosts: [{ urls: ["https://my.node.example"], source: "offchain" }],
  };

  it("allows unregistered owners anywhere and registered owners on a listed host", () => {
    expect(() =>
      assertSpaceCreationAllowed(
        { status: "unregistered", subject: SUBJECT, source: "offchain", hosts: [] },
        DEFAULT_TINYCLOUD_FALLBACK_HOST,
      ),
    ).not.toThrow();
    expect(() => assertSpaceCreationAllowed(listed, "https://my.node.example/")).not.toThrow();
  });

  it("refuses a registered owner on any host the record does not list", () => {
    const error = (() => {
      try {
        assertSpaceCreationAllowed(listed, DEFAULT_TINYCLOUD_FALLBACK_HOST);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(NodeRegistryEntryExistsError);
    expect(error).toMatchObject({
      code: "node_registry_entry_exists",
      registeredHosts: ["https://my.node.example"],
    });
    expect(() =>
      assertSpaceCreationAllowed({ ...listed, hosts: [] }, "https://my.node.example"),
    ).toThrow(NodeRegistryEntryExistsError);
  });

  it("refuses when the registry gave no verdict", () => {
    expect(() =>
      assertSpaceCreationAllowed(
        {
          status: "unavailable",
          subject: SUBJECT,
          source: "offchain",
          reason: "timeout",
          message: "location registry lookup timed out",
          hosts: [],
        },
        DEFAULT_TINYCLOUD_FALLBACK_HOST,
      ),
    ).toThrow(RegistryUnavailableError);
  });
});

describe("legacy-fallback default", () => {
  // A fresh module instance, so the once-per-process warning starts unset.
  const freshLocation = async (tag: string): Promise<typeof LocationModule> =>
    import(`./location.ts?${tag}`);

  it("still falls back when the registry has no record, warning once per process", async () => {
    const { resolveTinyCloudHosts } = await freshLocation("fallback-warning");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        const resolved = await resolveTinyCloudHosts(SUBJECT, {
          registryUrl: REGISTRY,
          autoDiscoverLocalNode: false,
          fetch: registry([notFound]),
        });
        expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
        expect(resolved.location.source).toBe("fallback");
      }
      const deprecations = warn.mock.calls.filter(([message]) =>
        String(message).includes("silent fallback will be removed"),
      );
      expect(deprecations).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when the registry record decides the host", async () => {
    const { resolveTinyCloudHosts } = await freshLocation("record-no-warning");
    const body = await recordBody(["/dns4/my.node.example/tcp/443/https"], 1);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await resolveTinyCloudHosts(SUBJECT, {
        registryUrl: REGISTRY,
        autoDiscoverLocalNode: false,
        fetch: registry([() => new Response(body)]),
      });
      expect(resolved.hosts).toEqual(["https://my.node.example"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
