import { basename, dirname, join, resolve } from "node:path";
import { createHermeticEncryptedNode } from "../../packages/node-sdk/src/test-support/hermetic-encrypted-node";
import type { CredentialFlowDescriptor } from "../../packages/sdk-core/src";
import type { CredentialRedirectResumeState } from "../../packages/web-sdk/src/credentials/types";
import { BrowserCredentialInteraction } from "../../packages/web-sdk/src/credentials/browser";
import { CredentialsService } from "../../packages/web-sdk/src/credentials/service";
import { OpenCredentialsHttpTransport } from "../../packages/web-sdk/src/credentials/transport";

const jsRoot = resolve(import.meta.dir, "../..");
const branch = basename(jsRoot);
const openCredentialsRoot = join(
  dirname(dirname(dirname(jsRoot))),
  "opencredentials",
  basename(dirname(jsRoot)),
  branch.replace("-js-sdk-", "-opencredentials-"),
);
const manifest = join(openCredentialsRoot, "rust/opencredentials_witness/Cargo.toml");
const fixtureDocument = await Bun.file(join(jsRoot, "packages/sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json")).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const descriptor = fixtureDocument.vectors[0]!.descriptor;
const requirement = {
  type: "TinyCloudCredentialRequirement" as const,
  version: 1 as const,
  profile: { id: descriptor.profile, version: 1 as const },
  credentialType: { id: descriptor.format.vct, version: 1 as const },
  claims: { email: "fixture@example.com" },
};

async function startFixture(): Promise<{ url: string; stop(): void }> {
  const process = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", manifest, "--features", "email-claim-fixture", "--bin", "credential-acquisition-fixture"], { stdout: "pipe", stderr: "inherit" });
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error(`credential fixture exited before startup (${await process.exited})`);
    buffered += decoder.decode(next.value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline < 0) continue;
    const startup = JSON.parse(buffered.slice(0, newline)) as { testOnly?: boolean; url?: string };
    if (startup.testOnly !== true || !startup.url?.startsWith("http://127.0.0.1:")) throw new Error("credential fixture startup record is invalid");
    return { url: startup.url, stop: () => process.kill() };
  }
}

const fixture = await startFixture();
const appRoot = join(openCredentialsRoot, "apps/open-credentials");
const hosted = Bun.spawn([join(appRoot, "node_modules/.bin/vite"), "--host", "127.0.0.1", "--port", "4174"], { cwd: appRoot, stdout: "ignore", stderr: "inherit" });
const hostedDeadline = Date.now() + 60_000;
while (Date.now() < hostedDeadline) {
  try {
    if ((await fetch("http://127.0.0.1:4174/")).ok) break;
  } catch { /* hosted app is still starting */ }
  await Bun.sleep(100);
}
if (Date.now() >= hostedDeadline) throw new Error("hosted credential app startup timed out");
const initialized = await createHermeticEncryptedNode();
const ownerDid = initialized.delegate.did;
const credentialSpaceId = `${ownerDid.replace(/^did:/, "tinycloud:")}:credentials`;
initialized.provisionKvSpace(credentialSpaceId);
let autoSignAttempts = 0;
let approvalCount = 0;
let creates = 0;
let resultReads = 0;
let browserCookie = "";
const service = new CredentialsService({
  get credentialHolderDid() { return initialized.delegate.credentialHolderDid; },
  get credentialHolderKid() { return initialized.delegate.credentialHolderKid; },
  session: () => initialized.delegate.session as any,
  autoSignCredentialBytes: async (bytes: Uint8Array) => { autoSignAttempts += 1; return initialized.delegate.autoSignCredentialBytes(bytes); },
  approveCredentialBytes: async (bytes: Uint8Array) => { approvalCount += 1; return initialized.delegate.approveCredentialBytes(bytes); },
  ensureOwnedSpaceHosted: async (name: string) => {
    if (name !== "credentials") throw new Error("unexpected credential space");
    return credentialSpaceId;
  },
  credentialSpaceOwnerDid: (spaceId: string) => initialized.delegate.credentialSpaceOwnerDid(spaceId),
  kvForSpace: (spaceId: string) => initialized.delegate.kvForSpace(spaceId),
});
const transport = new OpenCredentialsHttpTransport(descriptor, async (input, init) => {
  const requested = new URL(String(input));
  if (requested.pathname === "/v1/acquisitions" && init?.method === "POST") creates += 1;
  if (requested.pathname.endsWith("/result")) resultReads += 1;
  const response = await fetch(new URL(requested.pathname, fixture.url), init);
  if (requested.pathname === "/v1/acquisitions" && init?.method === "POST") browserCookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return response;
});

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4175,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ready: true });
    if (request.method === "POST" && url.pathname === "/start") {
      const { openerOrigin } = await request.json() as { openerOrigin: string };
      let resumeState: CredentialRedirectResumeState | undefined;
      let navigation = "";
      const abort = new AbortController();
      const redirectStore = {
        load: async () => undefined,
        save: async (state: CredentialRedirectResumeState) => { resumeState = state; },
        clear: async () => { resumeState = undefined; },
      };
      const browser = new BrowserCredentialInteraction("redirect", {
        opener: {} as Window,
        open: () => null,
        redirect: (target) => { navigation = target; abort.abort(); },
      });
      await service.ensure(requirement, {
        descriptor,
        interaction: "redirect",
        redirectStore,
        browser,
        transport,
        openerOrigin,
        signal: abort.signal,
      }).catch(() => undefined);
      if (!resumeState || !navigation || !browserCookie) return json({ error: "redirect was not initialized" }, 500);
      return json({ navigation, resumeState, browserCookie, fixtureUrl: fixture.url, interactionOrigin: descriptor.interaction.origin });
    }
    if (request.method === "POST" && url.pathname === "/resume") {
      const { openerOrigin, resumeState } = await request.json() as { openerOrigin: string; resumeState: CredentialRedirectResumeState };
      let cleared = false;
      const redirectStore = {
        load: async () => resumeState,
        save: async () => { throw new Error("resume must not save a second continuation"); },
        clear: async () => { cleared = true; },
      };
      const result = await service.ensure(requirement, { descriptor, interaction: "redirect", redirectStore, transport, openerOrigin });
      return json({
        status: result.status,
        claims: result.credential.claims,
        holderDid: result.credential.holderDid,
        activeHolderDid: initialized.delegate.credentialHolderDid,
        recordOwnerDid: result.record.ownerDid,
        receiptOwnerDid: result.receipt?.ownerDid,
        ownerDid,
        cleared,
      });
    }
    if (request.method === "POST" && url.pathname === "/durable") {
      const { openerOrigin } = await request.json() as { openerOrigin: string };
      const result = await service.ensure(requirement, { descriptor, interaction: "headless", transport, openerOrigin });
      return json({ status: result.status, creates, resultReads, autoSignAttempts, approvalCount });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      queueMicrotask(() => {
        initialized.stop();
        fixture.stop();
        hosted.kill();
        server.stop(true);
      });
      return json({ stopped: true });
    }
    return new Response("not found", { status: 404 });
  },
});

const shutdown = () => {
  initialized.stop();
  fixture.stop();
  hosted.kill();
  server.stop(true);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(JSON.stringify({ testOnly: true, url: `http://127.0.0.1:${server.port}` }));
