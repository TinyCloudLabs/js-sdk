import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureShareCommandServices, registerShareCommand } from "./share.js";
import { MemorySenderShareRecordStorage, type SharePolicyEvidence } from "@tinycloud/share-sdk";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, computeCid, didKeyFromEd25519PublicKey, encodeShareUrl, generateKey, seal, signEnvelopeV2, toBase64Url } from "@tinycloud/share-envelope";

async function runShare(args: readonly string[]): Promise<string> {
  const program = new Command();
  registerShareCommand(program);
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stdout.write;
  try { await program.parseAsync(["node", "tc", ...args], { from: "node" }); }
  finally { process.stdout.write = original; }
  return output;
}

async function runShareCaptured(args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  registerShareCommand(program);
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stderr.write;
  let exitCode = 0;
  try { await program.parseAsync(["node", "tc", ...args], { from: "node" }); }
  finally {
    exitCode = process.exitCode ?? 0;
    process.exitCode = previousExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { stdout, stderr, exitCode };
}

async function addressedFixture(): Promise<{ url: string; blob: Uint8Array; policy: SharePolicyEvidence }> {
  const issuerPrivateKey = new Uint8Array(32).fill(17);
  const recipientDid = "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav";
  const matcher = { kind: "recipientDid" as const, value: recipientDid };
  const policy = { issuerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(issuerPrivateKey)), recipientMatcher: matcher, version: 2 };
  const policyBytes = new TextEncoder().encode(canonicalize(policy));
  const digest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", policyBytes)));
  const envelope = signEnvelopeV2({
    version: 2,
    shareId: "command-auth-output",
    recipientMatcher: matcher,
    actions: ["read"],
    resource: { kind: "exact", path: "docs/readme.md" },
    target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:node.example", spaceId: "space" },
    delegationCid: "bafy-delegation",
    authorityMaterialHandle: "bafy-authority",
    authorityMaterialDigest: digest,
    contentSource: { kind: "kv", space: "space", path: "docs/readme.md", action: "tinycloud.kv/get" },
    contentSourceDigest: digest,
    authorizationTarget: { kind: "policy", policyCid: await computeCid(policyBytes), policyBytes: toBase64Url(policyBytes) },
    display: { filename: "readme.md" },
    expiry: "2030-01-01T00:00:00.000Z",
    encrypted: true,
    metadata: { mediaType: "text/markdown", byteLength: 5, filename: "readme.md" },
  }, issuerPrivateKey);
  const envelopeKey = generateKey();
  const sealed = await seal(new TextEncoder().encode(canonicalize(envelope)), envelopeKey);
  return {
    url: encodeShareUrl({ origin: "https://share.tinycloud.xyz", ciphertextCid: sealed.cid, key32: envelopeKey }),
    blob: sealed.blob,
    policy: {
      policyCid: await computeCid(policyBytes), signerDid: policy.issuerDid, registrationCid: "bafy-registration", shareId: envelope.shareId,
      recipientMatcher: envelope.recipientMatcher, target: envelope.target, resource: envelope.resource, actions: envelope.actions,
      contentSource: envelope.contentSource, contentSourceDigest: envelope.contentSourceDigest, delegationCid: envelope.delegationCid,
      authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, expiresAt: envelope.expiry,
    },
  };
}

describe("tc share command integration", () => {
  test("publishes, inspects, receives, and records one compact link", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-command-"));
    const input = join(root, "report.md");
    const output = join(root, "received");
    await writeFile(input, "# command round trip\n", "utf8");
    const blobs = new Map<string, Uint8Array>();
    const records = new MemorySenderShareRecordStorage();
    configureShareCommandServices({
      records,
      uploadBlob: async (value) => { blobs.set(value.cid, value.blob.slice()); return { cid: value.cid, deleteAfter: value.deleteAfter }; },
      fetchFn: Object.assign(async (inputUrl: string | URL | Request) => {
        const cid = new URL(String(inputUrl)).pathname.split("/").at(-1)!;
        const blob = blobs.get(cid);
        return blob === undefined ? new Response(null, { status: 404 }) : new Response(blob, { status: 200, headers: { "content-type": "application/vnd.ipld.raw" } });
      }, { preconnect: () => undefined }) as typeof globalThis.fetch,
    });

    const link = (await runShare(["share", "publish", input, "--viewer-origin", "https://share.tinycloud.xyz"])).trim();
    expect(link).toMatch(/^https:\/\/share\.tinycloud\.xyz\/s\//);
    expect((await runShare(["share", "inspect", link, "--viewer-origin", "https://share.tinycloud.xyz"])).trim()).toContain("Share ");
    const receivedPath = (await runShare(["share", "receive", link, "--output", output, "--viewer-origin", "https://share.tinycloud.xyz"])).trim();
    expect(await readFile(receivedPath, "utf8")).toBe("# command round trip\n");
    expect((await records.list()).length).toBe(1);
  });

  test("redacts token-bearing publish and receive authorization results in JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-auth-output-"));
    const input = join(root, "report.md");
    await writeFile(input, "# authorization output\n", "utf8");
    const token = "resume-token-must-never-appear";
    configureShareCommandServices({
      targetAdapter: { publish: async () => ({ state: "authorization-required", method: "openkey-device", resumeToken: token, continueUrl: "https://authority.example/continue" }) },
    });
    const published = await runShareCaptured(["share", "publish", input, "--to", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav", "--json"]);
    expect(published.exitCode).toBe(6);
    expect(JSON.parse(published.stdout)).toEqual({
      protocol: "tinycloud-share", version: 1,
      authorization: { state: "authorization-required", method: "openkey-device", next: "complete authorization through the configured authority adapter, then retry with the required proof" },
    });
    expect(`${published.stdout}${published.stderr}`).not.toContain(token);

    const fixture = await addressedFixture();
    configureShareCommandServices({
      fetchFn: Object.assign(async () => new Response(fixture.blob, { status: 200 }), { preconnect: () => undefined }) as typeof globalThis.fetch,
      trustedPolicyAuthority: { resolve: async () => fixture.policy },
      authorization: {
        begin: async () => ({ state: "authorization-required", method: "openkey-device", resumeToken: token, continueUrl: "https://authority.example/continue" }),
        resume: async () => ({ state: "denied", reason: "rejected" }),
      },
    });
    const received = await runShareCaptured(["share", "receive", fixture.url, "--json"]);
    expect(received.exitCode).toBe(6);
    expect(JSON.parse(received.stdout)).toEqual({
      protocol: "tinycloud-share", version: 1,
      authorization: { state: "authorization-required", method: "openkey-device", next: "complete authorization through the configured authority adapter, then retry with the required proof" },
    });
    expect(`${received.stdout}${received.stderr}`).not.toContain(token);
  });
});
