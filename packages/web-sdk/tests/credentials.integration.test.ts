import { afterAll, expect, test } from "bun:test";
import { basename, dirname, join, resolve } from "node:path";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";
import { canonicalDigest, credentialRequirementDigest, encodeBase64Url, sha256Base64Url, type CredentialFlowDescriptor, type CredentialRequirement } from "@tinycloud/sdk-core";
import { BrowserCredentialRedirectStore } from "../src/credentials/browser";
import { CredentialsService } from "../src/credentials/service";
import { OpenCredentialsHttpTransport } from "../src/credentials/transport";

const jsRoot = resolve(import.meta.dir, "../../..");
const branch = basename(jsRoot);
const worktreesRoot = dirname(dirname(dirname(jsRoot)));
const openCredentialsRoot = join(worktreesRoot, "opencredentials", basename(dirname(jsRoot)), branch.replace("-js-sdk-", "-opencredentials-"));
const manifest = join(openCredentialsRoot, "rust/opencredentials_witness/Cargo.toml");
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;
const synthetic = fixture.vectors[1]!.descriptor;

function requirement(descriptor: CredentialFlowDescriptor): CredentialRequirement {
  const name = descriptor.claims[0]!.name;
  return {
    type: "TinyCloudCredentialRequirement", version: 1,
    profile: { id: descriptor.profile, version: 1 }, credentialType: { id: descriptor.format.vct, version: 1 },
    claims: { [name]: name === "email" ? "fixture@example.com" : "fixture_handle" },
  };
}

function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    batchPut: async (items: { key: string; value: unknown }[]) => {
      for (const item of items) values.set(item.key, structuredClone(item.value));
      return { ok: true, data: { keys: items.map((item) => item.key), count: items.length } } as const;
    },
    get: async (key: string) => values.has(key)
      ? { ok: true, data: { data: structuredClone(values.get(key)), headers: { etag: `"${key}"`, get: () => null } } } as const
      : { ok: false, error: { code: "not-found", message: "not found", service: "kv" } } as const,
    list: async ({ prefix }: { prefix: string }) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(prefix)) } }) as const,
  } as any;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function startFixture(): Promise<{ url: string; stop(): void }> {
  if (!(await Bun.file(manifest).exists())) throw new Error(`paired OpenCredentials worktree not found at ${openCredentialsRoot}`);
  const process = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", manifest, "--features", "email-claim-fixture", "--bin", "credential-acquisition-fixture"], { stdout: "pipe", stderr: "inherit" });
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) throw new Error(`credential fixture exited before startup (${await process.exited})`);
    buffered += decoder.decode(next.value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const parsed = JSON.parse(buffered.slice(0, newline)) as { testOnly?: boolean; url?: string };
      if (parsed.testOnly !== true || typeof parsed.url !== "string" || !parsed.url.startsWith("http://127.0.0.1:")) throw new Error("credential fixture startup record is invalid");
      return { url: parsed.url, stop: () => process.kill() };
    }
  }
  process.kill();
  throw new Error("credential fixture startup timed out");
}

const acquisition = await startFixture();
const initialized = await createHermeticEncryptedNode();
afterAll(() => { acquisition.stop(); initialized.stop(); });

test("an initialized active session ensures mounted email and catalog-added synthetic credentials", async () => {
  const kv = memoryKv();
  const holderDid = initialized.delegate.credentialHolderDid;
  const holderKid = initialized.delegate.credentialHolderKid;
  const ownerDid = initialized.delegate.did;
  const spaceId = `${ownerDid.replace(/^did:/, "tinycloud:")}:credentials`;
  const client = {
    get sessionDid() { return initialized.delegate.sessionDid; },
    get credentialHolderDid() { return initialized.delegate.credentialHolderDid; },
    get credentialHolderKid() { return initialized.delegate.credentialHolderKid; },
    session: () => initialized.delegate.session as any,
    signSessionBytes: (bytes: Uint8Array) => initialized.delegate.signSessionBytes(bytes),
    autoSignCredentialBytes: (bytes: Uint8Array) => initialized.delegate.autoSignCredentialBytes(bytes),
    approveCredentialBytes: (bytes: Uint8Array) => initialized.delegate.approveCredentialBytes(bytes),
    ensureOwnedSpaceHosted: async (name: string) => { expect(name).toBe("credentials"); return spaceId; },
    credentialSpaceOwnerDid: (space: string) => initialized.delegate.credentialSpaceOwnerDid(space),
    kvForSpace: (space: string) => { expect(space).toBe(spaceId); return kv; },
  };
  expect(client.sessionDid).toBe(holderKid);
  expect(holderDid).not.toContain("#");
  expect(ownerDid).not.toBe(holderDid);
  const service = new CredentialsService(client);
  let creates = 0;
  let resultReads = 0;
  const transportFor = (descriptor: CredentialFlowDescriptor) => new OpenCredentialsHttpTransport(descriptor, async (input, init) => {
    const requested = new URL(String(input));
    if (requested.pathname === "/v1/acquisitions" && init?.method === "POST") creates += 1;
    if (requested.pathname.endsWith("/result")) resultReads += 1;
    return fetch(new URL(`${requested.pathname}`, acquisition.url), init);
  });

  const emailRequirement = requirement(email);
  const emailTransport = transportFor(email);
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const descriptorDigest = await canonicalDigest(email);
  const requirementDigest = await credentialRequirementDigest(emailRequirement);
  const created = await emailTransport.create({
    descriptor: email, descriptorDigest, requirement: emailRequirement, requirementDigest,
    holderDid, openerOrigin: "https://app.test", completionVerifierChallenge: await sha256Base64Url(verifier),
  });
  const pending = await emailTransport.state(created.requestId, verifier);
  expect(pending.nextStep?.type).toBe("mailbox_otp");
  await emailTransport.submitStep(created.requestId, verifier, "mailbox_otp", { otp: "246810" });
  const redirectStorage = memoryStorage();
  const redirectStore = new BrowserCredentialRedirectStore(redirectStorage);
  await redirectStore.save({
    type: "TinyCloudCredentialRedirectResume", version: 1, requestId: created.requestId,
    locator: created.locator, verifier, expiresAt: created.expiresAt, correlationId: created.correlationId,
    holderDid, descriptorDigest, requirementDigest, openerOrigin: "https://app.test",
  });

  const emailResult = await service.ensure(requirement(email), {
    descriptor: email, interaction: "redirect", transport: emailTransport, redirectStore, openerOrigin: "https://app.test",
  });
  expect(emailResult.status).toBe("acquired");
  expect(emailResult.credential.holderDid).toBe(holderDid);
  expect(emailResult.record.holderDid).toBe(holderDid);
  expect(emailResult.record.ownerDid).toBe(ownerDid);
  expect(emailResult.receipt?.ownerDid).toBe(ownerDid);
  expect(await redirectStore.load()).toBeUndefined();
  expect(resultReads).toBe(1);

  const syntheticResult = await service.ensure(requirement(synthetic), {
    descriptor: synthetic, interaction: "headless", transport: transportFor(synthetic), openerOrigin: "https://app.test",
    stepHandlers: { collect_input: async () => ({ acknowledged: true }) },
  });
  expect(syntheticResult.status).toBe("acquired");
  expect(syntheticResult.credential.holderDid).toBe(holderDid);
  const reused = await service.ensure(requirement(synthetic), { descriptor: synthetic, interaction: "headless", transport: transportFor(synthetic), openerOrigin: "https://app.test" });
  expect(reused.status).toBe("reused");
  expect(creates).toBe(2);
  expect(resultReads).toBe(2);
}, 120_000);
