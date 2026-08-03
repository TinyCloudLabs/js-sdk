import { basename, dirname, join, resolve } from "node:path";
import { createHermeticBrowserCredentialBoundary } from "../../packages/node-sdk/src/test-support/hermetic-encrypted-node";
import type { CredentialFlowDescriptor } from "../../packages/sdk-core/src";

const jsRoot = resolve(import.meta.dir, "../..");
const branch = basename(jsRoot);
const openCredentialsRoot = join(
  dirname(dirname(dirname(jsRoot))),
  "opencredentials",
  basename(dirname(jsRoot)),
  branch.replace("-js-sdk-", "-opencredentials-"),
);
const manifest = join(openCredentialsRoot, "rust/opencredentials_witness/Cargo.toml");
const fixtureDocument = await Bun.file(join(
  jsRoot,
  "packages/sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json",
)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const descriptor = fixtureDocument.vectors[0]!.descriptor;

async function startFixture(): Promise<{ url: string; stop(): void }> {
  const process = Bun.spawn([
    "cargo", "run", "--quiet", "--manifest-path", manifest,
    "--features", "email-claim-fixture", "--bin", "credential-acquisition-fixture",
  ], { stdout: "pipe", stderr: "inherit" });
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
    if (startup.testOnly !== true || !startup.url?.startsWith("http://127.0.0.1:")) {
      throw new Error("credential fixture startup record is invalid");
    }
    return { url: startup.url, stop: () => process.kill() };
  }
}

const fixture = await startFixture();
const appRoot = join(openCredentialsRoot, "apps/open-credentials");
const hosted = Bun.spawn([
  join(appRoot, "node_modules/.bin/vite"), "--host", "127.0.0.1", "--port", "4174",
], { cwd: appRoot, stdout: "ignore", stderr: "inherit" });
const hostedDeadline = Date.now() + 60_000;
while (Date.now() < hostedDeadline) {
  try {
    if ((await fetch("http://127.0.0.1:4174/")).ok) break;
  } catch { /* hosted app is still starting */ }
  await Bun.sleep(100);
}
if (Date.now() >= hostedDeadline) throw new Error("hosted credential app startup timed out");

// Public address of the deterministic browser fixture wallet. Its private key
// exists only in the browser test client and enters through the normal provider API.
const boundary = await createHermeticBrowserCredentialBoundary(
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4175,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ready: true });
    if (request.method === "GET" && url.pathname === "/config") {
      return json({
        descriptor,
        fixtureBackendUrl: fixture.url,
        hostedBackendUrl: "http://127.0.0.1:4174",
        tinycloudBackendUrl: boundary.host,
        ownerDid: boundary.ownerDid,
        credentialsSpaceId: boundary.credentialsSpaceId,
      });
    }
    if (request.method === "GET" && url.pathname === "/stats") return json(boundary.stats());
    if (request.method === "POST" && url.pathname === "/stop") {
      queueMicrotask(() => {
        boundary.stop();
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
  boundary.stop();
  fixture.stop();
  hosted.kill();
  server.stop(true);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(JSON.stringify({ testOnly: true, url: `http://127.0.0.1:${server.port}` }));
