import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShareAuthorityAdapters } from "../share/adapters.js";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";

afterEach(() => configureShareCommandServices({}));

const DID_KEY = "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav";
const DID_PKH = "did:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01";

const TARGETS = [["domain", "domain:example.com"], ["did", DID_KEY], ["did", DID_PKH]] as const;

/**
 * The REAL default services (what `tc` wires in `index.ts`), over a `fetch` that counts and refuses every request and a
 * profile lookup that counts. A refusal must reach neither: no `/info`, no authentication, no key or profile access.
 */
function realServices() {
  const counts = { requests: [] as string[], profileLookups: 0 };
  const authority = createShareAuthorityAdapters({
    origin: "https://share.example",
    profileName: async () => { counts.profileLookups++; return "never-selected"; },
    fetchFn: (async (input: unknown) => { counts.requests.push(String(input)); throw new Error("network must not be reached"); }) as unknown as typeof fetch,
  });
  configureShareCommandServices({
    targetAdapter: authority.targetAdapter,
    records: authority.records,
    delivery: authority.delivery,
    assertDomainDelivery: authority.assertDomainDelivery,
    revocation: authority.revocation,
    nativeReader: authority.nativeReader,
    artifactStore: authority.artifactStore,
    links: authority.links,
    shortLinkInvitations: true,
  });
  return counts;
}

async function runPublish(args: readonly string[]) {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const result = await runShareCaptured(["share", "publish", ...args, "--json"]);
    return { ...result, exitCode: exitCode ?? result.exitCode, error: JSON.parse(result.stderr).error as { code: string; message: string } };
  } finally { process.exit = originalExit; }
}

async function withSource<T>(body: (source: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tc2242-addressed-unavailable-"));
  try {
    const source = join(root, "note.md");
    await writeFile(source, "synthetic refusal input");
    return await body(source);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("domain and DID addressed publication release refusal, through the registered command on the real services", () => {
  test.each(TARGETS)("refuses %s target %s with UNAVAILABLE (exit 4) before any request or profile access", async (kind, target) => {
    const counts = realServices();
    await withSource(async (source) => {
      const result = await runPublish([source, "--to", target]);
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.exitCode).toBe(4);
      expect(result.error.message).toBe(`${kind}-addressed shares are not available in this release; nothing was shared`);
    });
    expect(counts.requests).toEqual([]);
    expect(counts.profileLookups).toBe(0);
  });

  test.each(TARGETS)("refuses %s target %s with notify, edit, short-link and expiry options present, still making no request", async (kind, target) => {
    const counts = realServices();
    await withSource(async (source) => {
      const result = await runPublish([source, "--to", target, "--action", "read", "--action", "edit", "--full-link", "--expires", "1h"]);
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.exitCode).toBe(4);
      expect(result.error.message).toBe(`${kind}-addressed shares are not available in this release; nothing was shared`);
    });
    expect(counts.requests).toEqual([]);
    expect(counts.profileLookups).toBe(0);
  });

  test.each(TARGETS)("keeps --ongoing ahead of the %s target %s refusal", async (_kind, target) => {
    const counts = realServices();
    const result = await runPublish(["/nonexistent/tc2242-never-read-source", "--to", target, "--ongoing"]);
    expect(result.error.code).toBe("UNSUPPORTED_TARGET");
    expect(result.exitCode).toBe(2);
    expect(counts.requests).toEqual([]);
    expect(counts.profileLookups).toBe(0);
  });

  test("still refuses an exact email with its own message, before the adapter", async () => {
    const counts = realServices();
    const result = await runPublish(["/nonexistent/tc2242-never-read-source", "--to", "person@example.com"]);
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.exitCode).toBe(4);
    expect(result.error.message).toBe("email-addressed shares are not available in this release; nothing was shared");
    expect(counts.requests).toEqual([]);
    expect(counts.profileLookups).toBe(0);
  });

  test.each([["--to anyone", ["--to", "anyone"]], ["the default target", []]])("does not refuse a bearer publish (%s): it gets past the adapter's target check", async (_label, to) => {
    const counts = realServices();
    await withSource(async (source) => {
      const result = await runPublish([source, ...to]);
      // The real bearer path needs an authenticated profile, so the lookup happens (this is the proof it proceeded); no
      // domain/DID refusal message is produced.
      expect(result.error.message).not.toMatch(/not available in this release/);
    });
    expect(counts.profileLookups).toBeGreaterThan(0);
  });
});
