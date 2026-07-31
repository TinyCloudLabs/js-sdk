import { describe, expect, test } from "bun:test";
import { createTimedFetch, type HttpTimingSample } from "./request-timing";

describe("createTimedFetch", () => {
  test("records header and consumed-body timings without retaining authorization", async () => {
    const samples: HttpTimingSample[] = [];
    const authorization = "secret-invocation";
    const timedFetch = createTimedFetch(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-length": "11", "content-type": "application/json" },
        }),
      {
        server: "https://node.example",
        context: () => ({ benchmark: "sdk.kv.get", iteration: 3 }),
        record: (sample) => samples.push(sample),
      },
    );

    const response = await timedFetch("https://node.example/invoke?ignored=true", {
      method: "POST",
      headers: { Authorization: authorization },
      body: "request",
    });
    expect(await response.json()).toEqual({ ok: true });

    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.phase)).toEqual(["headers", "total"]);
    expect(samples[0]).toMatchObject({
      requestId: 1,
      benchmark: "sdk.kv.get",
      iteration: 3,
      method: "POST",
      path: "/invoke",
      status: 200,
      requestBodyBytes: 7,
      responseBodyBytes: 11,
      authorizationBytes: authorization.length,
    });
    expect(JSON.stringify(samples)).not.toContain(authorization);
    expect(samples[1]!.durationMs).toBeGreaterThanOrEqual(samples[0]!.durationMs);
  });

  test("does not record requests for another origin", async () => {
    const samples: HttpTimingSample[] = [];
    const timedFetch = createTimedFetch(
      async () => new Response("ok"),
      {
        server: "https://node.example",
        context: () => ({ benchmark: "setup", iteration: -1 }),
        record: (sample) => samples.push(sample),
      },
    );

    expect(await (await timedFetch("https://registry.example/info")).text()).toBe("ok");
    expect(samples).toEqual([]);
  });

  test("records response headers when the caller does not consume the body", async () => {
    const samples: HttpTimingSample[] = [];
    const timedFetch = createTimedFetch(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      {
        server: "https://node.example",
        context: () => ({ benchmark: "sdk.kv.put", iteration: 1 }),
        record: (sample) => samples.push(sample),
      },
    );

    const response = await timedFetch("https://node.example/invoke", { method: "POST" });

    expect(response.ok).toBe(true);
    expect(samples.map((sample) => sample.phase)).toEqual(["headers"]);
    expect(samples[0]).toMatchObject({
      benchmark: "sdk.kv.put",
      method: "POST",
      path: "/invoke",
      status: 200,
    });
  });

  test("records failed requests at both milestones", async () => {
    const samples: HttpTimingSample[] = [];
    const timedFetch = createTimedFetch(
      async () => {
        throw new Error("connection refused");
      },
      {
        server: "https://node.example",
        context: () => ({ benchmark: "sdk.kv.put", iteration: 1 }),
        record: (sample) => samples.push(sample),
      },
    );

    await expect(timedFetch("https://node.example/invoke")).rejects.toThrow("connection refused");
    expect(samples.map((sample) => sample.phase)).toEqual(["headers", "total"]);
    expect(samples.every((sample) => sample.ok === false)).toBe(true);
    expect(samples.every((sample) => sample.error === "connection refused")).toBe(true);
  });
});
