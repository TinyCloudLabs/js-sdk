import { describe, expect, test } from "bun:test";
import { AccountService } from "./AccountService";
import type { Result } from "@tinycloud/sdk-services";

const record = (id: string) => ({
  app_id: id,
  manifests: [{ app_id: id, name: `App ${id}`, knowledge: true }],
});
const response = (data: unknown) => ({
  ok: true as const,
  data: { data, headers: {} },
});
const failure = (code: string) => ({
  ok: false as const,
  error: { code, message: "private response body", service: "kv" },
});

function fixture(
  records: Record<string, unknown>,
  options: {
    missing?: string;
    error?: string;
    truncated?: boolean;
    delay?: boolean;
  } = {},
) {
  const calls = {
    list: 0,
    gets: [] as string[],
    batches: [] as string[][],
    writes: 0,
    active: 0,
    maxActive: 0,
  };
  const load = (key: string) =>
    key === options.missing ? failure("KV_NOT_FOUND") : response(records[key]);
  const kv = {
    async list() {
      calls.list++;
      return {
        ok: true as const,
        data: {
          keys: Object.keys(records).reverse(),
          truncated: options.truncated,
        },
      };
    },
    async get(key: string) {
      calls.gets.push(key);
      return load(key);
    },
    async batchGet(keys: string[]) {
      calls.batches.push(keys);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, 3));
      calls.active--;
      return options.error
        ? failure(options.error)
        : {
            ok: true as const,
            data: {
              results: keys.map((key) => ({ key, result: load(key) })),
              count: keys.length,
            },
          };
    },
    async put() {
      calls.writes++;
      throw new Error("discovery must not write");
    },
  };
  const service = new AccountService({
    getDid: () => "did:test:owner",
    getHost: () => "https://node.example",
    getPrimarySpaceId: () => "primary",
    getAccountSpaceId: () => "account",
    getSpaces: () => ({ get: () => ({ kv }) }) as any,
    getAccountDb: () => {
      calls.writes++;
      throw new Error("discovery must not access index");
    },
  });
  return { service, calls, kv };
}

function success<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}

async function detailed(service: AccountService, options = {}) {
  expect(typeof service.applications.listDetailed).toBe("function");
  return service.applications.listDetailed(options);
}

describe("canonical account application discovery", () => {
  test("text/plain JSON has the same manifests and metadata as a JSON object", async () => {
    const value = { ...record("notes"), updated_at: "2026-10-01T12:00:00Z" };
    const { service } = fixture({
      "applications/notes": JSON.stringify(value),
    });
    const text = success(await service.applications.get("notes"));
    const object = success(
      await fixture({ "applications/notes": value }).service.applications.get(
        "notes",
      ),
    );
    expect(text).toEqual(object);
    expect(text).toMatchObject({
      appId: "notes",
      name: "App notes",
      manifests: value.manifests,
      updatedAt: value.updated_at,
    });
  });

  test("five text records and a legacy record use one list and one batch and preserve usable applications", async () => {
    const values = Object.fromEntries(
      ["e", "c", "d", "a", "b"].map((id) => [
        `applications/${id}`,
        JSON.stringify(record(id)),
      ]),
    );
    values["applications/legacy"] = JSON.stringify({
      app_id: "legacy",
      manifest: record("legacy").manifests[0],
      secret: "do not echo",
    });
    const { service, calls } = fixture(values);
    const result = success(await detailed(service));
    expect(result.applications.map((app) => app.appId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(result).toMatchObject({
      complete: false,
      issues: [
        {
          key: "applications/legacy",
          code: "LEGACY_APPLICATION_RECORD",
          category: "legacy",
          field: "manifest",
        },
      ],
    });
    expect(JSON.stringify(result.issues)).not.toContain("do not echo");
    expect(calls).toMatchObject({ list: 1, gets: [], writes: 0 });
    expect(calls.batches).toHaveLength(1);
    expect(
      await service.applications.list({ preferIndex: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "LEGACY_APPLICATION_RECORD" },
    });
    expect(calls.writes).toBe(0);
  });

  test.each([
    ["{ secret", "invalid_json", "$"],
    [null, "invalid_shape", "$"],
    [42, "invalid_shape", "$"],
    [[], "invalid_shape", "$"],
    [{ manifests: [] }, "invalid_shape", "manifests"],
    [{ manifests: [null] }, "invalid_manifest", "manifests[0]"],
    [
      { manifests: [{ app_id: "a", name: "A", knowledge: false }] },
      "invalid_manifest",
      "manifests[0]",
    ],
    [{ ...record("b") }, "identity_mismatch", "app_id"],
    [{ ...record("a"), appId: "b" }, "identity_mismatch", "app_id"],
    [
      { manifests: record("b").manifests },
      "identity_mismatch",
      "manifests[0].app_id",
    ],
    [{ ...record("a"), updated_at: 42 }, "invalid_metadata", "updated_at"],
    [
      { ...record("a"), updatedAt: "not a date" },
      "invalid_metadata",
      "updated_at",
    ],
    [{ ...record("a"), name: 9 }, "invalid_metadata", "name"],
    [
      { manifests: [{ app_id: "a", name: "A", description: 42 }] },
      "invalid_metadata",
      "manifests[0].description",
    ],
    [
      { ...record("a"), manifest_hash: "wrong" },
      "hash_mismatch",
      "manifest_hash",
    ],
  ])(
    "rejects malformed record %p without echoing its body",
    async (value, category, field) => {
      const result = await fixture({
        "applications/a": value,
      }).service.applications.get("a");
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_APPLICATION_RECORD",
          meta: { key: "applications/a", category, field },
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );

  test("valid aliases and canonical hashes survive round-trip; mismatched aliases are rejected", async () => {
    const application = success(
      await fixture({ "applications/a": record("a") }).service.applications.get(
        "a",
      ),
    );
    const value = {
      ...record("a"),
      appId: "a",
      manifestHash: application.manifestHash,
      name: "Registry name",
      description: "Registry description",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    expect(
      success(
        await fixture({ "applications/a": value }).service.applications.get(
          "a",
        ),
      ),
    ).toMatchObject({
      name: "Registry name",
      description: "Registry description",
      manifestHash: application.manifestHash,
    });
    expect(
      await fixture({
        "applications/a": { ...value, updated_at: "2026-10-02T00:00:00Z" },
      }).service.applications.get("a"),
    ).toMatchObject({
      ok: false,
      error: { meta: { category: "invalid_metadata", field: "updated_at" } },
    });
  });

  test("bounds reads to fifty records and two concurrent batches", async () => {
    const values = Object.fromEntries(
      Array.from({ length: 121 }, (_, n) => {
        const id = String(n);
        return [`applications/${id}`, record(id)];
      }),
    );
    const { service, calls } = fixture(values, { delay: true });
    expect(success(await detailed(service)).applications).toHaveLength(121);
    expect(calls.batches.map((keys) => keys.length)).toEqual([50, 50, 21]);
    expect(calls.maxActive).toBe(2);
  });

  test("a concurrent deletion is an explicit incomplete record issue", async () => {
    const { service } = fixture(
      { "applications/a": record("a"), "applications/b": record("b") },
      { missing: "applications/b" },
    );
    expect(success(await detailed(service))).toMatchObject({
      complete: false,
      applications: [{ appId: "a" }],
      issues: [{ key: "applications/b", code: "APPLICATION_RECORD_MISSING" }],
    });
  });

  test.each(["AUTH_UNAUTHORIZED", "NETWORK_ERROR"])(
    "%s fails listing without individual get fallback",
    async (error) => {
      const { service, calls } = fixture(
        { "applications/a": record("a") },
        { error },
      );
      expect(await detailed(service)).toMatchObject({
        ok: false,
        error: { code: error },
      });
      expect(calls.gets).toEqual([]);
    },
  );

  test("truncation and byte bounds never report complete discovery", async () => {
    expect(
      success(await detailed(fixture({}, { truncated: true }).service)),
    ).toMatchObject({
      complete: false,
      issues: [{ code: "APPLICATION_REGISTRY_INCOMPLETE" }],
    });
    expect(
      await detailed(
        fixture({
          "applications/a": JSON.stringify({
            ...record("a"),
            extra: "x".repeat(1024 * 1024),
          }),
        }).service,
      ),
    ).toMatchObject({ ok: false, error: { code: "KV_RESPONSE_TOO_LARGE" } });
    const values = Object.fromEntries(
      Array.from({ length: 5 }, (_, n) => [
        `applications/${n}`,
        JSON.stringify({ ...record(String(n)), extra: "x".repeat(900000) }),
      ]),
    );
    expect(await detailed(fixture(values).service)).toMatchObject({
      ok: false,
      error: { code: "KV_RESPONSE_TOO_LARGE" },
    });
  });

  test("explicit unsupported-host compatibility uses bounded individual reads", async () => {
    const { service, calls } = fixture({
      "applications/a": record("a"),
      "applications/b": record("b"),
    });
    expect(
      success(await detailed(service, { batchSupport: "unsupported" }))
        .complete,
    ).toBe(true);
    expect(calls.batches).toEqual([]);
    expect(calls.gets).toEqual(["applications/a", "applications/b"]);
  });
});

test("non-serializable object records are explicit issues instead of bypassing byte accounting", async () => {
  const circular: Record<string, unknown> = { ...record("a") };
  circular.private = circular;
  const { service } = fixture({
    "applications/a": circular,
    "applications/b": record("b"),
  });
  expect(success(await detailed(service))).toMatchObject({
    complete: false,
    applications: [{ appId: "b" }],
    issues: [{ key: "applications/a", category: "invalid_shape", field: "$" }],
  });
});
