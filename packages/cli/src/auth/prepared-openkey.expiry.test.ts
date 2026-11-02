// TC-2276: the prepared OpenKey login tells the SDK the user may pick the lifetime, builds its node with the requested
// lifetime, and still refuses a signed expiry beyond `--expiry`. The OpenKey page is simulated: the handoff returns a
// result signed by a local owner key for the SIWE the SDK prepared, with a lifetime chosen by the test.

import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";

const nodeSdk = await import("@tinycloud/node-sdk");
type NodeConfig = NonNullable<ConstructorParameters<typeof nodeSdk.TinyCloudNode>[0]>;
const created: Array<{ config: NodeConfig; signInOptions: unknown[] }> = [];

class RecordingNode extends nodeSdk.TinyCloudNode {
  private readonly record: { config: NodeConfig; signInOptions: unknown[] };
  constructor(config: NodeConfig) {
    super(config);
    this.record = { config, signInOptions: [] };
    created.push(this.record);
  }
  override async signInWithOpenKey(
    authorizeFn: Parameters<InstanceType<typeof nodeSdk.TinyCloudNode>["signInWithOpenKey"]>[0],
    options?: Parameters<InstanceType<typeof nodeSdk.TinyCloudNode>["signInWithOpenKey"]>[1],
  ): Promise<void> {
    this.record.signInOptions.push(options);
    return super.signInWithOpenKey(authorizeFn, options);
  }
}
mock.module("@tinycloud/node-sdk", () => ({ ...nodeSdk, TinyCloudNode: RecordingNode }));

const signer = new nodeSdk.PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7");
const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
let pickedLifetimeMs = 0;
let handoffDelayMs = 0;
const realHandoff = await import("./prepared-openkey.js");
mock.module("./prepared-openkey.js", () => ({
  ...realHandoff,
  startPreparedOpenKeyHandoff: async (options: { prepared: { siwe: string } }) => {
    if (handoffDelayMs > 0) setSystemTime(new Date(Date.now() + handoffDelayMs));
    const siwe = options.prepared.siwe.replace(/^Expiration Time: .*$/m, `Expiration Time: ${new Date(Date.now() + pickedLifetimeMs).toISOString()}`);
    const selectedActionKeys: string[] = [];
    const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
    for (const [resource, actions] of Object.entries(extractRecapAttenuations(siwe))) {
      const { space, path } = parseCanonicalRecapResource(resource);
      const grouped = new Map<string, string[]>();
      for (const ability of Object.keys(actions)) {
        const service = ability.slice(0, ability.indexOf("/"));
        if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
        grouped.set(service, [...(grouped.get(service) ?? []), ability]);
      }
      for (const [service, granted] of grouped) permissions.push({ service, space, path, actions: granted });
    }
    const result = {
      protocolVersion: 1 as const, address: await signer.getAddress(), signature: await signer.signMessage(siwe),
      signedMessage: siwe, selectedActionKeys, permissions,
    };
    return { result: Promise.resolve(result), url: "https://openkey.test/delegate#tv2=test", complete: async () => undefined };
  },
}));

const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-prepared-expiry-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");

const HOUR = 3600_000;
const hits = { delegate: 0 };
const node = Bun.serve({ port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: ["encryption-named-keys-v1"] });
  if (path === "/delegate" && request.method === "POST") { hits.delegate++; return Response.json({ activated: [], skipped: [] }); }
  return new Response(`Unexpected node request: ${path}`, { status: 404 });
} });
const host = node.url.origin;

afterAll(async () => {
  node.stop(true);
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  created.length = 0;
  hits.delegate = 0;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setProfile("owner", {
    name: "owner", host, chainId: 1, spaceName: "default", did: "did:key:prior", ownerDid,
    posture: "owner-openkey", authMethod: "openkey", createdAt: "2026-10-01T00:00:00.000Z",
  });
  await ProfileManager.clearSession("owner");
});

const login = () => refreshOpenKeySession("owner", host, {
  expectedOwner: ownerDid, replication: { prefixes: ["notes/"] }, expiry: "1h", replaceSession: true, noPopup: true,
});

describe("prepared replica login", () => {
  test("opts in to a changed expiry, builds the node with the requested lifetime, and saves a shorter pick as signed", async () => {
    pickedLifetimeMs = 20 * 60_000;
    await login();
    expect(created).toHaveLength(1);
    expect(created[0]!.signInOptions).toEqual([{ expiryChangeable: true, maxExpiresAt: expect.any(Function) }]);
    expect(created[0]!.config.sessionExpirationMs).toBe(HOUR);
    const saved = await ProfileManager.getSession("owner") as { expiresAt?: string; siwe: string };
    expect(saved.expiresAt).toBe(/Expiration Time: (.+)/.exec(saved.siwe)?.[1]);
    expect(Date.parse(saved.expiresAt!) - Date.now()).toBeLessThan(21 * 60_000);
  });

  test("an expiry beyond the requested --expiry is still refused and nothing is saved", async () => {
    pickedLifetimeMs = 2 * HOUR;
    await expect(login()).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(await ProfileManager.getSession("owner")).toBeNull();
  });
});

describe("prepared --keys login", () => {
  test("opts in to a changed expiry too", async () => {
    pickedLifetimeMs = 20 * 60_000;
    // Named-key setup after sign-in needs a real node; only the sign-in call is under test, so its outcome is ignored.
    await refreshOpenKeySession("owner", host, {
      expectedOwner: ownerDid, keys: "notes", expiry: "1h", replaceSession: true, noPopup: true,
    }).catch(() => undefined);
    expect(created).toHaveLength(1);
    expect(created[0]!.signInOptions).toEqual([{ expiryChangeable: true, maxExpiresAt: expect.any(Function) }]);
    expect(created[0]!.config.sessionExpirationMs).toBe(HOUR);
  });
});

// Review follow-up: the CLI ceiling is also passed to the SDK, so an above-ceiling pick is refused BEFORE the session is
// activated (no /delegate request), not after.
describe("the --expiry ceiling is enforced before activation", () => {
  test("replica login: refused with OPENKEY_EXPIRY_EXCEEDED, the latest allowed time named, and no activation request", async () => {
    pickedLifetimeMs = 2 * HOUR;
    await expect(login()).rejects.toMatchObject({
      code: "OPENKEY_EXPIRY_EXCEEDED",
      message: expect.stringMatching(/the latest allowed is \d{4}-[^)]*\)\. Choose an earlier lifetime in OpenKey, or re-run with a longer --expiry\. No session was saved\.$/),
    });
    expect(hits.delegate).toBe(0);
    expect(await ProfileManager.getSession("owner")).toBeNull();
  });

  test("--keys login: the same", async () => {
    pickedLifetimeMs = 2 * HOUR;
    await expect(refreshOpenKeySession("owner", host, {
      expectedOwner: ownerDid, keys: "notes", expiry: "1h", replaceSession: true, noPopup: true,
    })).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(hits.delegate).toBe(0);
  });

  test("a pick at the --expiry it asked for is accepted (activation runs)", async () => {
    pickedLifetimeMs = HOUR;
    await login();
    expect(hits.delegate).toBeGreaterThan(0);
    expect(await ProfileManager.getSession("owner")).not.toBeNull();
  });

  test("the ceiling is read when the approval arrives: a slow approval is not refused for its delay", async () => {
    // Approved four minutes after the request was prepared, for the full hour it asked for: later than request time + 1 h
    // + 30 s, so a ceiling computed when the request was prepared would refuse it.
    pickedLifetimeMs = HOUR;
    handoffDelayMs = 4 * 60_000;
    try {
      await login();
    } finally {
      handoffDelayMs = 0;
      setSystemTime();
    }
    expect(await ProfileManager.getSession("owner")).not.toBeNull();
  });
});

// Without --expiry the SDK requests its default 30 day session. That request, plus the same 30 s margin, is the ceiling,
// so the no-`--expiry` case is held as tightly as an explicit one (on master the SDK refused any changed expiry).
describe("without --expiry the default 30 day request is the ceiling", () => {
  const DAY = 24 * HOUR;
  const loginDefault = () => refreshOpenKeySession("owner", host, {
    expectedOwner: ownerDid, replication: { prefixes: ["notes/"] }, replaceSession: true, noPopup: true,
  });

  test("hands the SDK a maximum, read when the approval arrives", async () => {
    pickedLifetimeMs = 29 * DAY;
    await loginDefault();
    expect(created[0]!.signInOptions).toEqual([{ expiryChangeable: true, maxExpiresAt: expect.any(Function) }]);
  });

  test("replica login: a 31 day pick is refused before activation, naming the default lifetime and the latest allowed time", async () => {
    pickedLifetimeMs = 31 * DAY;
    await expect(loginDefault()).rejects.toMatchObject({
      code: "OPENKEY_EXPIRY_EXCEEDED",
      message: expect.stringMatching(/default 30 day lifetime.*the latest allowed is \d{4}-[^)]*\)\. Choose an earlier lifetime in OpenKey, or re-run with a longer --expiry\. No session was saved\.$/),
    });
    expect(hits.delegate).toBe(0);
    expect(await ProfileManager.getSession("owner")).toBeNull();
  });

  test("--keys login: a 31 day pick is refused before activation", async () => {
    pickedLifetimeMs = 31 * DAY;
    await expect(refreshOpenKeySession("owner", host, {
      expectedOwner: ownerDid, keys: "notes", replaceSession: true, noPopup: true,
    })).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(hits.delegate).toBe(0);
  });

  test("a 29 day pick is accepted (activation runs)", async () => {
    pickedLifetimeMs = 29 * DAY;
    await loginDefault();
    expect(hits.delegate).toBeGreaterThan(0);
    expect(await ProfileManager.getSession("owner")).not.toBeNull();
  });

  test("the ceiling includes the 30 second margin: 20 s over 30 days is accepted, 40 s over is refused", async () => {
    pickedLifetimeMs = 30 * DAY + 20_000;
    await loginDefault();
    expect(await ProfileManager.getSession("owner")).not.toBeNull();
    await ProfileManager.clearSession("owner");
    hits.delegate = 0;
    pickedLifetimeMs = 30 * DAY + 40_000;
    await expect(loginDefault()).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(hits.delegate).toBe(0);
  });

  test("a slow approval is not refused for its delay: the full 30 days picked four minutes after the request", async () => {
    pickedLifetimeMs = 30 * DAY;
    handoffDelayMs = 4 * 60_000;
    try {
      await loginDefault();
    } finally {
      handoffDelayMs = 0;
      setSystemTime();
    }
    expect(await ProfileManager.getSession("owner")).not.toBeNull();
  });
});
