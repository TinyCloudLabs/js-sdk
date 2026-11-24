import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedShare, TargetPublishInput } from "@tinycloud/share-sdk";
import { configureShareCommandServices, shareCliError } from "./share.js";
import { SharePublishAuthorityError } from "../share/errors.js";
import { runShareCaptured } from "./share.integration-harness.js";

afterEach(() => configureShareCommandServices({}));

const SHORT = "https://share.example/s/aaaaaaaaaaaaaaaaaaaaaaaaaa#v=4&k=key";
const descriptorFixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { name: string; descriptor: unknown }[] };
const emailDescriptor = descriptorFixture.vectors.find((vector) => vector.name === "email")!.descriptor;
const ISSUER = ["--issuer-did", "did:web:issuer.credentials.org", "--issuer-kid", "did:web:issuer.credentials.org#controller"] as const;

async function withSource<T>(body: (source: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "tc3582-email-share-"));
  try {
    const source = join(directory, "note.md");
    await writeFile(source, "# note\n");
    return await body(source, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function run(args: readonly string[]) {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const result = await runShareCaptured(["share", "publish", ...args, "--json"]);
    return { ...result, exitCode: exitCode ?? result.exitCode };
  } finally { process.exit = originalExit; }
}

function errorOf(stderr: string): { code: string; message: string } {
  return JSON.parse(stderr).error as { code: string; message: string };
}

/** A publisher that records what the command hands it and answers with a published exact-email share. */
function recordingPublisher() {
  const requests: TargetPublishInput[] = [];
  configureShareCommandServices({
    links: { show: async (published) => ({ url: published.url, short: true }), unlink: async () => "deleted" },
    shortLinkInvitations: true,
    targetAdapter: { async publish(input) {
      requests.push(input);
      if (input.target.kind !== "email") throw new Error("expected an email target");
      return {
        protocol: "tinycloud-share", version: 1, url: SHORT, link: { kind: "policy", cid: "bafy-email" },
        metadata: {
          protocol: "tinycloud-share", version: 1, shareId: "share-email", origin: "https://share.example",
          target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
          resource: { kind: "exact", path: "shares/share-email/note.md" }, actions: ["read"],
          expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
          recipientMatcher: { kind: "exactEmail", value: input.target.address },
        },
      } satisfies PublishedShare;
    } },
  });
  return requests;
}

describe("exact-email share publication", () => {
  test.each(["person@example.com", "email:person@example.com"])("hands %s to the publisher with no credential override, so the built-in OpenCredentials issuer is used", async (target) => {
    const requests = recordingPublisher();
    await withSource(async (source) => {
      const result = await run([source, "--to", target]);
      expect(result.exitCode).toBe(0);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.target).toEqual({ kind: "email", address: "person@example.com" });
    expect(requests[0]!.credentialDescriptor).toBeUndefined();
    expect(requests[0]!.issuerDid).toBeUndefined();
    expect(requests[0]!.issuerKid).toBeUndefined();
  });

  test("hands the descriptor file and issuer to the publisher when all three options are given", async () => {
    const requests = recordingPublisher();
    await withSource(async (source, directory) => {
      const descriptor = join(directory, "descriptor.json");
      await writeFile(descriptor, JSON.stringify(emailDescriptor));
      expect((await run([source, "--to", "person@example.com", "--credential-descriptor", descriptor, ...ISSUER])).exitCode).toBe(0);
    });
    expect(requests[0]!.credentialDescriptor).toEqual(emailDescriptor);
    expect(requests[0]!.issuerDid).toBe("did:web:issuer.credentials.org");
    expect(requests[0]!.issuerKid).toBe("did:web:issuer.credentials.org#controller");
  });

  test.each([
    ["only the issuer", ["--issuer-did", "did:web:issuer.credentials.org"]],
    ["no issuer", ["--credential-descriptor", "/nonexistent/tc3582-descriptor.json"]],
    ["no descriptor", [...ISSUER]],
  ])("refuses %s before reading anything or publishing", async (_label, flags) => {
    const requests = recordingPublisher();
    const result = await run(["/nonexistent/tc3582-never-read-source", "--to", "person@example.com", ...flags]);
    expect(errorOf(result.stderr).code).toBe("INVALID_ARGUMENT");
    expect(result.exitCode).toBe(2);
    expect(requests).toHaveLength(0);
  });

  test("refuses an unreadable or non-JSON descriptor file before publishing", async () => {
    const requests = recordingPublisher();
    await withSource(async (source, directory) => {
      const notJson = join(directory, "descriptor.json");
      await writeFile(notJson, "not json");
      for (const path of [notJson, join(directory, "missing.json")]) {
        const result = await run([source, "--to", "person@example.com", "--credential-descriptor", path, ...ISSUER]);
        expect(errorOf(result.stderr).code).toBe("INVALID_ARGUMENT");
        expect(result.exitCode).toBe(2);
      }
    });
    expect(requests).toHaveLength(0);
  });

  test("--notify is accepted for an exact email and invites that address", async () => {
    const requests: TargetPublishInput[] = [];
    const delivered: string[] = [];
    configureShareCommandServices({
      links: { show: async (published) => ({ url: published.url, short: true }), unlink: async () => "deleted" },
      shortLinkInvitations: true,
      targetAdapter: { async publish(input) { requests.push(input); return (await publishedFor(input)); } },
      delivery: { async deliver(request) { delivered.push(request.recipient); return "delivered"; } },
    });
    await withSource(async (source) => {
      const result = await run([source, "--to", "person@example.com", "--notify"]);
      expect(result.exitCode).toBe(0);
    });
    expect(delivered).toEqual(["person@example.com"]);
  });
});

async function publishedFor(input: TargetPublishInput): Promise<PublishedShare> {
  if (input.target.kind !== "email") throw new Error("expected an email target");
  return {
    protocol: "tinycloud-share", version: 1, url: SHORT, link: { kind: "policy", cid: "bafy-email" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId: "share-email", origin: "https://share.example",
      target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
      resource: { kind: "exact", path: "shares/share-email/note.md" }, actions: ["read"],
      expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
      recipientMatcher: { kind: "exactEmail", value: input.target.address },
    },
    deliveryMaterial: { envelope: {}, shareCid: "bafy-email", sealedEnvelope: "AA", envelopeKey: "AA" },
  } satisfies PublishedShare;
}

describe("credential options on a target that is not an exact email", () => {
  test.each(["anyone", "domain:example.com", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav"])("keeps the credential-option refusal for %s", async (target) => {
    const requests = recordingPublisher();
    const result = await run(["/nonexistent/tc3582-never-read-source", "--to", target, "--credential-descriptor", "/nonexistent/tc3582-never-read-descriptor.json"]);
    expect(errorOf(result.stderr).code).toBe("INVALID_ARGUMENT");
    expect(result.exitCode).toBe(2);
    expect(requests).toHaveLength(0);
  });
});

describe("the error for an issuer that is not usable", () => {
  test("names what to do for each cause, and shares nothing in both", () => {
    const unreachable = shareCliError(new SharePublishAuthorityError({ kind: "email-issuer-unavailable", reason: "unreachable" }));
    const mismatch = shareCliError(new SharePublishAuthorityError({ kind: "email-issuer-unavailable", reason: "mismatch" }));
    expect(unreachable).toMatchObject({ code: "UNAVAILABLE", exitCode: 4 });
    expect(unreachable.message).toMatch(/try again shortly/);
    expect(mismatch).toMatchObject({ code: "UNAVAILABLE", exitCode: 4 });
    expect(mismatch.message).not.toMatch(/try again/);
    for (const error of [unreachable, mismatch]) expect(error.message).toMatch(/nothing was shared/);
  });
});
