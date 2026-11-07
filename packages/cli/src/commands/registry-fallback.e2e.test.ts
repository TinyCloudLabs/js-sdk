import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profileConfigPath, readJson, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { registryOwnerKeyV2, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { makeHome, removeHome, runTc, writeDelegateProfile, type WaitHermetic } from "../test-support/secrets-wait-harness.js";

const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: { secretPayloadValue: string }): Promise<WaitHermetic> };

for (const mode of ["503", "transport", "timeout", "4xx", "known", "node-down", "warm503", "warm-output-failure"] as const) {
  test(`actual CLI ${mode} registry route preserves fallback/refusal and stderr isolation`, async () => {
    const home = await makeHome();
    const fixture = await createHermeticEncryptedNode({ secretPayloadValue: "tc2481-cold-TEST-value" });
    let registryRequests = 0;
    const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      registryRequests++;
      return mode === "timeout" ? new Promise<Response>(() => {})
        : new Response("TEST registry unavailable", { status: mode === "4xx" ? 403 : 503 });
    } });
    const registryOrigin = registry.url.origin;
    let warmNode: Bun.Server<undefined> | undefined, unlisted: Bun.Server<undefined> | undefined;
    let unlistedRequests = 0;
    let beforeCache = "";
    const warm = mode === "warm503" || mode === "warm-output-failure";
    const outputPath = join(home, "late-output");
    try {
      const profile = "cold-test-delegate";
      await writeDelegateProfile(home, fixture, profile, { grant: await fixture.mintDelegation() });
      if (warm) {
        const { nodeId } = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
        warmNode = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: nodeId, shareInvitationPublicKey: "A".repeat(43) });
          if (mode === "warm-output-failure" && request.method === "POST" && url.pathname.endsWith("/decrypt")) {
            await mkdir(outputPath, { recursive: true });
          }
          return fetch(new Request(`${fixture.host}${url.pathname}${url.search}`, request));
        } });
        unlisted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unlistedRequests++; return new Response("unlisted", { status: 500 }); } });
        const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
        const record = await signLocationRecordV2({ version: 2, subject: fixture.ownerDid, sequence: 50,
          updated_at: new Date().toISOString(), nodes: [{ did: nodeId, url: warmNode.url.origin }],
          spaces: [{ space: fixture.restorableSession.spaceId.toLowerCase(), nodes: [{ did: nodeId, mode: "read-write" }] }],
          encryptionNode: nodeId,
        }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
        await withTinyCloudStateRoot(home, async () => {
          const ownerKey = registryOwnerKeyV2(fixture.ownerDid);
          await createProfileRegistryCacheStore(profile).update(ownerKey, async () => ({
            ownerKey, responseBody: ` { "record": ${JSON.stringify(record)} }\n`, fetchedAt: Date.now(), sequence: 50,
          }));
        });
        beforeCache = await readFile(join(home, ".tinycloud", "profiles", profile, "registry-cache.json"), "utf8");
      }
      await withTinyCloudStateRoot(home, async () => {
        const path = profileConfigPath(profile);
        const config = await readJson<Record<string, unknown>>(path);
        await writeJsonAtomic(path, { ...config, tinycloudRegistryUrl: registryOrigin, ...(unlisted === undefined ? {} : { host: unlisted.url.origin }) });
        if (mode === "known") await createProfileRegistrySequenceStore(profile).set(registryOwnerKeyV2(fixture.ownerDid), 0);
      });
      if (mode === "transport") await registry.stop(true);
      const preload = join(home, "fixture-only.mjs");
      const origins = [fixture.host, registryOrigin, warmNode?.url.origin, unlisted?.url.origin].filter(Boolean);
      await writeFile(preload, `const raw=globalThis.fetch;const allowed=new Set(${JSON.stringify(origins)});globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed.has(url.origin))throw Error('Non-fixture origin refused');return raw(input,init)};`);
      const beforeReads = fixture.invocations().filter(({ action }) => action === "tinycloud.kv/get").length;
      if (mode === "node-down") fixture.stop();
      const result = await runTc(home, ["--json", "--profile", profile, "secrets", "get", "HERMETIC_DELEGATION_CANARY", "--raw",
        ...(mode === "warm-output-failure" ? ["--output", outputPath] : [])], {
        env: { NODE_OPTIONS: `--import=${preload}`, TC_REGISTRY_URL: registryOrigin },
      });
      if (mode === "known" || mode === "4xx") {
        expect({ exit: result.exitCode, stdout: result.stdout }).toEqual({ exit: 1, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REGISTRY_UNAVAILABLE" } });
        expect(result.stderr).not.toContain("using_default_node");
        expect(fixture.invocations().filter(({ action }) => action === "tinycloud.kv/get").length).toBe(beforeReads);
      } else if (mode === "node-down") {
        expect({ exit: result.exitCode, stdout: result.stdout }).toEqual({ exit: 6, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({ error: {
          code: "NODE_NOT_RESPONDING",
          warnings: [{ code: "REGISTRY_UNAVAILABLE", reason: "using_default_node" }],
        } });
      } else if (warm) {
        if (mode === "warm-output-failure") {
          expect({ exit: result.exitCode, stdout: result.stdout }).toEqual({ exit: 2, stdout: "" });
          expect(JSON.parse(result.stderr)).toMatchObject({ error: {
            code: "INVALID_ARGUMENT",
            warnings: [{ code: "REGISTRY_UNAVAILABLE", reason: "using_cached_settings" }],
          } });
        } else {
          expect({ exit: result.exitCode, stdout: result.stdout.trim() }).toEqual({ exit: 0, stdout: "tc2481-cold-TEST-value" });
          expect(JSON.parse(result.stderr)).toEqual({
            warnings: [{ code: "REGISTRY_UNAVAILABLE", reason: "using_cached_settings" }],
          });
          expect(result.stderr.trim().split("\n")).toHaveLength(1);
        }
        expect(fixture.invocations().filter(({ action }) => action === "tinycloud.kv/get").length).toBeGreaterThan(beforeReads);
        expect(unlistedRequests).toBe(0);
        expect(await readFile(join(home, ".tinycloud", "profiles", profile, "registry-cache.json"), "utf8")).toBe(beforeCache);
      } else {
        expect({ exit: result.exitCode, stdout: result.stdout.trim() }).toEqual({ exit: 0, stdout: "tc2481-cold-TEST-value" });
        const lines = result.stderr.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual({ warnings: [{ code: "REGISTRY_UNAVAILABLE", reason: "using_default_node" }] });
      }
      if (!warm) expect(await Bun.file(join(home, ".tinycloud", "profiles", profile, "registry-cache.json")).exists()).toBe(false);
      if (mode !== "transport") expect(registryRequests).toBeGreaterThan(0);
    } finally {
      registry.stop(true);
      warmNode?.stop(true); unlisted?.stop(true);
      fixture.stop();
      await removeHome(home);
    }
  }, 150_000);
}
