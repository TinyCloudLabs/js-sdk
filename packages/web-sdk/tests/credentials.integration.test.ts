import { afterAll, expect, mock, test } from "bun:test";
import { basename, dirname, join, resolve } from "node:path";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";
import { createOpenKeyCallbackSigningStrategy, type CredentialFlowDescriptor, type CredentialRequirement } from "@tinycloud/sdk-core";
import { BrowserCredentialInteraction, BrowserCredentialRedirectStore, InlineCredentialInteraction } from "../src/credentials/browser";
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
const redirectInitialized = await createHermeticEncryptedNode();
afterAll(() => { acquisition.stop(); initialized.stop(); redirectInitialized.stop(); });

test("an initialized active session ensures an email credential through an inline host without a popup", async () => {
  const holderDid = initialized.delegate.credentialHolderDid;
  const holderKid = initialized.delegate.credentialHolderKid;
  const ownerDid = initialized.delegate.did;
  const spaceId = `${ownerDid.replace(/^did:/, "tinycloud:")}:credentials`;
  initialized.provisionKvSpace(spaceId);
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
    kvForSpace: (space: string) => { expect(space).toBe(spaceId); return initialized.delegate.kvForSpace(space); },
  };
  expect(client.sessionDid).toBe(holderKid);
  expect(holderDid).not.toContain("#");
  expect(ownerDid).not.toBe(holderDid);
  const service = new CredentialsService(client);
  let creates = 0;
  let resultReads = 0;
  let sdkProofSubmissions = 0;
  const transportFor = (descriptor: CredentialFlowDescriptor) => new OpenCredentialsHttpTransport(descriptor, async (input, init) => {
    const requested = new URL(String(input));
    if (requested.pathname === "/v1/acquisitions" && init?.method === "POST") creates += 1;
    if (requested.pathname.endsWith("/result")) resultReads += 1;
    if (requested.pathname.endsWith("/proof") && init?.method === "POST") sdkProofSubmissions += 1;
    return fetch(new URL(`${requested.pathname}`, acquisition.url), init);
  });

  let inlinePresented = 0;
  const hostedEmailInteraction = new InlineCredentialInteraction(async (input) => {
    inlinePresented += 1;
    expect(input).toEqual({ signal: expect.any(AbortSignal) });
    return {
      wake: async () => undefined,
      close: () => undefined,
      closed: () => false,
      requestProof: async ({ stepId }) => {
        expect(stepId).toBe("mailbox_otp");
        return { otp: "246810" };
      },
    };
  });

  const emailTransport = transportFor(email);
  const emailResult = await service.ensure(requirement(email), {
    descriptor: email, interaction: "inline", browser: hostedEmailInteraction, transport: emailTransport, openerOrigin: "https://app.test",
  });
  expect(emailResult.status).toBe("acquired");
  expect(emailResult.credential.holderDid).toBe(holderDid);
  expect(emailResult.record.holderDid).toBe(holderDid);
  expect(emailResult.record.ownerDid).toBe(ownerDid);
  expect(emailResult.receipt?.ownerDid).toBe(ownerDid);
  expect(inlinePresented).toBe(1);
  expect(sdkProofSubmissions).toBe(1);
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

test("a locator-only redirect returns after hosted proof and a restored SDK session completes acquisition", async () => {
  const holderDid = redirectInitialized.delegate.credentialHolderDid;
  const ownerDid = redirectInitialized.delegate.did;
  const spaceId = `${ownerDid.replace(/^did:/, "tinycloud:")}:credentials`;
  redirectInitialized.provisionKvSpace(spaceId);
  const client = {
    get credentialHolderDid() { return redirectInitialized.delegate.credentialHolderDid; },
    get credentialHolderKid() { return redirectInitialized.delegate.credentialHolderKid; },
    session: () => redirectInitialized.delegate.session as any,
    autoSignCredentialBytes: (bytes: Uint8Array) => redirectInitialized.delegate.autoSignCredentialBytes(bytes),
    approveCredentialBytes: (bytes: Uint8Array) => redirectInitialized.delegate.approveCredentialBytes(bytes),
    ensureOwnedSpaceHosted: async () => spaceId,
    credentialSpaceOwnerDid: (space: string) => redirectInitialized.delegate.credentialSpaceOwnerDid(space),
    kvForSpace: () => redirectInitialized.delegate.kvForSpace(spaceId),
  };
  const service = new CredentialsService(client);
  let browserCookie = "";
  const transport = new OpenCredentialsHttpTransport(email, async (input, init) => {
    const requested = new URL(String(input));
    const response = await fetch(new URL(requested.pathname, acquisition.url), init);
    if (requested.pathname === "/v1/acquisitions" && init?.method === "POST") browserCookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    return response;
  });
  const redirectStore = new BrowserCredentialRedirectStore(memoryStorage());
  const unload = new AbortController();
  let navigation = "";
  let returnedTo = "";
  const navigationAdapter = new BrowserCredentialInteraction("redirect", {
    opener: {} as Window,
    open: () => null,
    redirect: (url) => { navigation = url; },
  });
  const browser = {
    kind: "redirect" as const,
    start: async (input: { interaction: CredentialFlowDescriptor["interaction"]; locator: string; signal?: AbortSignal }) => {
      const surface = await navigationAdapter.start(input);
      const hosted = async (suffix: string, init: RequestInit = {}) => {
        const response = await fetch(new URL(`/v1/acquisitions/${input.locator}${suffix}`, acquisition.url), {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), cookie: browserCookie, "content-type": "application/json" },
        });
        expect(response.ok).toBe(true);
        return response.json() as Promise<any>;
      };
      const initial = await hosted("/state");
      const challenge = await hosted("/challenge", { method: "POST", body: JSON.stringify({ step: "mailbox_otp", stepVersion: 1 }) });
      await hosted("/proof", { method: "POST", body: JSON.stringify({ step: "mailbox_otp", stepVersion: 1, challengeNonce: challenge.challengeNonce, proof: { otp: "246810" } }) });
      const afterProof = await hosted("/state");
      expect(initial.state).toBe("challenge_required");
      expect(afterProof.state).toBe("holder_binding_required");
      returnedTo = afterProof.openerOrigin;
      unload.abort();
      return surface;
    },
  };

  await expect(service.ensure(requirement(email), {
    descriptor: email, interaction: "redirect", browser, transport, redirectStore,
    openerOrigin: "https://app.test", signal: unload.signal,
  })).rejects.toMatchObject({ code: "CANCELED" });
  const interactionUrl = new URL(navigation);
  expect(interactionUrl.pathname).toMatch(/^\/credentials\/acquire\/[A-Za-z0-9_-]{32}$/);
  expect(interactionUrl.search).toBe("");
  expect(interactionUrl.hash).toBe("");
  expect(returnedTo).toBe("https://app.test");
  expect(await redirectStore.load()).toBeDefined();

  const resumed = await service.ensure(requirement(email), {
    descriptor: email, interaction: "redirect", transport, redirectStore, openerOrigin: "https://app.test",
  });
  expect(resumed.status).toBe("acquired");
  expect(resumed.credential.holderDid).toBe(holderDid);
  expect(resumed.record.ownerDid).toBe(ownerDid);
  expect(await redirectStore.load()).toBeUndefined();
}, 120_000);

test("an initialized OpenKey session reports normal approval rejection as recoverable", async () => {
  const automaticDecision = mock(async () => new Response(JSON.stringify({
    approved: false,
    needsApproval: true,
    reason: "normal approval required",
  }), { status: 200 }));
  const requestApproval = mock(async () => ({
    approved: false,
    reason: "user rejected credential signing",
  }));
  const openKey = await createHermeticEncryptedNode({
    delegateSignStrategy: createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      fetch: automaticDecision,
      requestApproval,
    }),
  });
  try {
    const service = new CredentialsService({
      get credentialHolderDid() { return openKey.delegate.credentialHolderDid; },
      get credentialHolderKid() { return openKey.delegate.credentialHolderKid; },
      session: () => openKey.delegate.session as any,
      autoSignCredentialBytes: (bytes: Uint8Array) => openKey.delegate.autoSignCredentialBytes(bytes),
      approveCredentialBytes: (bytes: Uint8Array) => openKey.delegate.approveCredentialBytes(bytes),
      ensureOwnedSpaceHosted: async () => { throw new Error("rejected credentials must not be stored"); },
      credentialSpaceOwnerDid: () => openKey.delegate.did,
      kvForSpace: () => { throw new Error("rejected credentials must not be stored"); },
    });
    const transport = new OpenCredentialsHttpTransport(synthetic, async (input, init) => {
      const requested = new URL(String(input));
      return fetch(new URL(requested.pathname, acquisition.url), init);
    });

    await expect(service.acquire(requirement(synthetic), {
      descriptor: synthetic,
      interaction: "headless",
      transport,
      openerOrigin: "https://app.test",
      stepHandlers: { collect_input: async () => ({ acknowledged: true }) },
    })).rejects.toMatchObject({ code: "SIGNATURE_REJECTED", recoverable: true });
    expect(automaticDecision).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  } finally {
    openKey.stop();
  }
}, 120_000);
