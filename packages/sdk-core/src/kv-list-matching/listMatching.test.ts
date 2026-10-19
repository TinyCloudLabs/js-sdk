import { describe, expect, test } from "bun:test";
import {
  ErrorCodes,
  KVService,
  type FetchRequestInit,
  type FetchResponse,
  type IServiceContext,
  type InvokeAnyEntry,
  type Result,
  type ServiceHeaders,
} from "@tinycloud/sdk-services";
import { listMatching } from "./index";

function response(
  ok: boolean,
  status: number,
  body: unknown,
  statusText = ok ? "OK" : "Error"
): FetchResponse {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: () => null,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body)
      ).buffer as ArrayBuffer,
    blob: async () =>
      new Blob([typeof body === "string" ? body : JSON.stringify(body)]),
  };
}

function headerValue(headers: ServiceHeaders | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match?.[1];
}

function createContext(
  fetchImpl: IServiceContext["fetch"],
  invokeCalls: Array<{ service: string; path: string; action: string }> = [],
  invokeAnyCalls?: Array<{ entries: InvokeAnyEntry[] }>
): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: (_session, service, path, action) => {
      invokeCalls.push({ service, path, action });
      return {
        Authorization: "Bearer signed-invocation",
        "x-test-path": path,
      };
    },
    invokeAny: invokeAnyCalls
      ? (_session, entries) => {
          invokeAnyCalls.push({ entries });
          return {
            Authorization: "Bearer signed-batch-invocation",
          };
        }
      : undefined,
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: [],
    },
  };
}

describe("listMatching (partial-segment listing, client-side)", () => {
  // A stand-in for node >= 1.19.0 list semantics (TC-731):
  //  - the prefix matches WHOLE segments only: `qa/b` lists `qa/b` and
  //    `qa/b/...`, never `qa/b00`; a trailing slash lists that folder;
  //  - the listing is recursive (descendants come back with full keys);
  //  - results are paged by `x-tinycloud-limit` with an opaque numeric cursor.
  // `grant` models a delegation: a list whose prefix lies outside it is 403.
  function nodeListing(
    stored: string[],
    opts: { pageSize?: number; grant?: string; listedPrefixes?: string[] } = {}
  ) {
    const sorted = [...stored].sort();
    return async (_url: string, init?: FetchRequestInit): Promise<FetchResponse> => {
      const prefix = headerValue(init?.headers, "x-test-path") ?? "";
      opts.listedPrefixes?.push(prefix);
      if (opts.grant !== undefined && !(prefix + "/").startsWith(opts.grant.replace(/\/?$/, "/"))) {
        return response(false, 403, "Unauthorized Action: not covered by the delegation", "Forbidden");
      }
      const folder = prefix.replace(/\/$/, "");
      const matching = sorted.filter(
        (key) => folder === "" || key === folder || key.startsWith(`${folder}/`)
      );
      const size = Number(headerValue(init?.headers, "x-tinycloud-limit") ?? opts.pageSize ?? matching.length);
      const start = Number(headerValue(init?.headers, "x-tinycloud-cursor") ?? 0);
      const page = matching.slice(start, start + size);
      const more = start + size < matching.length;
      const result = response(true, 200, page);
      result.headers.get = (name: string) => {
        if (name.toLowerCase() === "x-tinycloud-truncated") return String(more);
        if (name.toLowerCase() === "x-tinycloud-next-cursor") return more ? String(start + size) : null;
        return null;
      };
      return result;
    };
  }

  function serviceOver(fetchImpl: IServiceContext["fetch"]): KVService {
    const service = new KVService({});
    service.initialize(createContext(fetchImpl));
    return service;
  }

  const KEYS = ["qa/a", "qa/b00", "qa/b01", "qa/c00", "qa/b/one", "qa/b/two", "qa/b/deep/three", "root", "rootbeer", "z/qa"];
  const keysOf = (result: Result<{ keys: string[] }>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    return result.data.keys.sort();
  };

  test("a partial matches by name prefix; the node's whole-segment list does not", async () => {
    const service = serviceOver(nodeListing(KEYS));
    // The premise: the node itself returns nothing for a partial segment.
    expect(keysOf(await service.list({ prefix: "qa/b0" }))).toEqual([]);
    // The helper finds the siblings by listing the folder, and drops `qa/c00`.
    // `qa/b` is a name that also has children, so the key AND its descendants
    // come back, exactly as `list` reports them.
    expect(keysOf(await listMatching(service, "qa/b"))).toEqual([
      "qa/b/deep/three", "qa/b/one", "qa/b/two", "qa/b00", "qa/b01",
    ]);
    expect(keysOf(await listMatching(service, "qa/b0"))).toEqual(["qa/b00", "qa/b01"]);
  });

  test("an exact folder (trailing slash) returns its contents, recursively", async () => {
    const service = serviceOver(nodeListing(KEYS));
    expect(keysOf(await listMatching(service, "qa/b/"))).toEqual([
      "qa/b/deep/three", "qa/b/one", "qa/b/two",
    ]);
  });

  test("no match returns an empty list, not an error", async () => {
    const service = serviceOver(nodeListing(KEYS));
    expect(await listMatching(service, "qa/zzz")).toEqual({ ok: true, data: { keys: [] } });
    expect(await listMatching(service, "nope/")).toEqual({ ok: true, data: { keys: [] } });
  });

  test("a partial at depth 2+ lists only the deepest folder", async () => {
    const listedPrefixes: string[] = [];
    const service = serviceOver(nodeListing(KEYS, { listedPrefixes }));
    expect(keysOf(await listMatching(service, "qa/b/t"))).toEqual(["qa/b/two"]);
    expect(keysOf(await listMatching(service, "qa/b/deep/th"))).toEqual(["qa/b/deep/three"]);
    expect(listedPrefixes).toEqual(["qa/b/", "qa/b/deep/"]);
  });

  test("an empty partial is just the folder; an empty prefix is the whole space", async () => {
    const service = serviceOver(nodeListing(KEYS));
    expect(keysOf(await listMatching(service, "qa/b/deep/"))).toEqual(["qa/b/deep/three"]);
    expect(keysOf(await listMatching(service, ""))).toEqual([...KEYS].sort());
  });

  test("a root-level partial (no slash) lists the space root", async () => {
    const listedPrefixes: string[] = [];
    const service = serviceOver(nodeListing(KEYS, { listedPrefixes }));
    expect(keysOf(await listMatching(service, "root"))).toEqual(["root", "rootbeer"]);
    expect(listedPrefixes).toEqual([""]);
  });

  test("follows every page and finds matches on all of them", async () => {
    const stored = Array.from({ length: 25 }, (_, i) => `qa/b${String(i).padStart(2, "0")}`)
      .concat(Array.from({ length: 10 }, (_, i) => `qa/c${i}`));
    let requests = 0;
    const inner = nodeListing(stored);
    const service = serviceOver(async (url, init) => {
      requests += 1;
      return inner(url, init);
    });
    const keys = keysOf(await listMatching(service, "qa/b", { limit: 4 }));
    expect(keys).toEqual(stored.filter((key) => key.startsWith("qa/b")).sort());
    expect(keys).toHaveLength(25);
    // 35 keys in the folder at 4 per page: the whole folder is read (9 pages),
    // not just the pages that contain matches. That is the documented cost.
    expect(requests).toBe(9);
  });

  test("removePrefix strips the folder, not the partial", async () => {
    const service = serviceOver(nodeListing(KEYS));
    expect(keysOf(await listMatching(service, "qa/b0", { removePrefix: true }))).toEqual(["b00", "b01"]);
    expect(keysOf(await listMatching(service, "root", { removePrefix: true }))).toEqual(["root", "rootbeer"]);
  });

  test("never widens scope: only the folder is listed, and an ungranted folder surfaces list's error", async () => {
    const listedPrefixes: string[] = [];
    const service = serviceOver(nodeListing(KEYS, { grant: "qa/b", listedPrefixes }));

    // Inside the grant: works, and the only thing requested is the folder.
    expect(keysOf(await listMatching(service, "qa/b/t"))).toEqual(["qa/b/two"]);
    expect(listedPrefixes).toEqual(["qa/b/"]);

    // The folder `qa/` is outside a grant on `qa/b`: the helper fails with the
    // same error `list` gives for that folder, and does not retry anything
    // narrower or wider.
    listedPrefixes.length = 0;
    const viaHelper = await listMatching(service, "qa/b0");
    const viaList = await service.list({ path: "qa/" });
    expect(viaHelper.ok).toBe(false);
    expect(viaHelper).toEqual(viaList);
    expect(listedPrefixes).toEqual(["qa/", "qa/"]);
  });

  test("a page error discards partial results", async () => {
    const inner = nodeListing(Array.from({ length: 10 }, (_, i) => `qa/b${i}`), { pageSize: 3 });
    let calls = 0;
    const service = serviceOver(async (url, init) =>
      ++calls === 3 ? response(false, 500, "boom") : inner(url, init)
    );
    const result = await listMatching(service, "qa/b");
    expect(result.ok).toBe(false);
  });

  test("a node that repeats its cursor cannot make the helper loop", async () => {
    const service = serviceOver(async () => {
      const stuck = response(true, 200, ["qa/b0"]);
      stuck.headers.get = (name: string) =>
        name.toLowerCase() === "x-tinycloud-next-cursor" ? "same" : null;
      return stuck;
    });
    const result = await listMatching(service, "qa/b");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR } });
  });

  test("works on a prefixed view: the folder is resolved under the view's prefix", async () => {
    const listedPrefixes: string[] = [];
    const service = serviceOver(
      nodeListing(["notes/qa/b00", "notes/qa/b01", "notes/qa/c00", "notes/qa/b/x", "other/qa/b99"], { pageSize: 2, listedPrefixes })
    );
    const notes = service.withPrefix("notes");
    // Keys come back relative to the view, as `notes.list()` returns them.
    expect(keysOf(await listMatching(notes, "qa/b"))).toEqual(["qa/b/x", "qa/b00", "qa/b01"]);
    expect(keysOf(await listMatching(notes, "qa/b", { removePrefix: true }))).toEqual(["b/x", "b00", "b01"]);
    // Only ever `notes/qa/`: never the view's siblings.
    expect([...new Set(listedPrefixes)]).toEqual(["notes/qa/"]);
    // A root-level partial lists the view's own root.
    expect(keysOf(await listMatching(notes, "qa"))).toEqual(["qa/b/x", "qa/b00", "qa/b01", "qa/c00"]);
  });
});
