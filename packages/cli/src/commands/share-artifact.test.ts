import { Command } from "commander";
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySenderShareRecordStorage, type PublishedShare, type TargetPublishInput } from "@tinycloud/share-sdk";
import { publishArtifactVersion, type ArtifactStore } from "@tinycloud/share-sdk/artifact";
import { configureShareCommandServices, registerShareCommand } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";
import { SharePublishAuthorityError } from "../share/errors.js";

const viewerOrigin = "https://share-dev.tinycloud.link";
const did = "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav";

/** handleError ends the process; record its exit code and let the action return instead. */
async function refusal(args: readonly string[]): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const { stderr, stdout } = await runShareCaptured(args);
    return { exitCode, stderr, stdout };
  } finally { process.exit = originalExit; }
}

async function input(content = "# report\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tc-share-artifact-"));
  const path = join(root, "report.md");
  await writeFile(path, content, "utf8");
  return path;
}

function publishedFor(request: TargetPublishInput): PublishedShare {
  const artifact = request.artifact === undefined ? undefined : { id: request.artifact.id, version: 3, mode: "pinned" as const };
  return {
    protocol: "tinycloud-share", version: 1, url: `${viewerOrigin}/viewer#tc1=opaque`,
    link: { kind: "native", cid: "bafy-native" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId: "bafy-native", origin: viewerOrigin,
      target: { kind: "bearer", origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "owner-space" },
      resource: { kind: "exact", path: `artifacts/${request.artifact?.id}/versions/3/${request.filename}` }, actions: ["read"],
      expiresAt: request.expiresAt.toISOString(), display: { filename: request.filename }, recipientMatcher: { kind: "bearer" },
      enforcementDelegationCid: "bafy-native", ...(artifact === undefined ? {} : { artifact }),
    },
  };
}

describe("tc share publish --artifact", () => {
  test("passes the artifact id and note to the publisher and reports artifactId, version and mode in JSON", async () => {
    const seen: TargetPublishInput[] = [];
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { seen.push(request); return publishedFor(request); } } });
    const result = await runShareCaptured(["share", "publish", await input(), "--artifact", "art_report", "--note", "first cut", "--viewer-origin", viewerOrigin, "--json"]);
    expect(seen[0]?.artifact).toEqual({ id: "art_report", note: "first cut" });
    expect(JSON.parse(result.stdout)).toMatchObject({ artifactId: "art_report", version: 3, mode: "pinned" });
    // The link never appears in machine output.
    expect(result.stdout).not.toContain("tc1=");
  });

  test("`--artifact new` mints a fresh valid artifact id", async () => {
    const seen: TargetPublishInput[] = [];
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { seen.push(request); return publishedFor(request); } } });
    await runShareCaptured(["share", "publish", await input(), "--artifact", "new", "--viewer-origin", viewerOrigin, "--json"]);
    await runShareCaptured(["share", "publish", await input(), "--artifact", "new", "--viewer-origin", viewerOrigin, "--json"]);
    expect(seen.map((request) => request.artifact?.id)).toEqual([expect.stringMatching(/^art_[0-9a-f]{16}$/), expect.stringMatching(/^art_[0-9a-f]{16}$/)]);
    expect(seen[0]?.artifact?.id).not.toBe(seen[1]?.artifact?.id);
  });

  test("refuses edit on a pinned share and --note without an artifact, before publishing", async () => {
    let published = 0;
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { published += 1; return publishedFor(request); } } });
    const file = await input();
    const edit = await refusal(["share", "publish", file, "--to", did, "--artifact", "art_report", "--action", "edit", "--json"]);
    expect(edit.exitCode).toBe(2);
    expect(edit.stderr).toContain("--action edit is not available for artifact shares");
    const note = await refusal(["share", "publish", file, "--note", "x", "--json"]);
    expect(note.stderr).toContain("--note requires --artifact");
    expect(published).toBe(0);
  });

  test("--ongoing is refused with one message for every target and flag combination, and never reaches the publisher", async () => {
    let published = 0;
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { published += 1; return publishedFor(request); } } });
    const file = await input();
    const combinations: readonly (readonly string[])[] = [
      ["--ongoing"],
      ["--artifact", "art_report", "--ongoing"],
      ["--artifact", "new", "--ongoing"],
      ["--to", did, "--artifact", "art_report", "--ongoing"],
      ["--to", did, "--artifact", "art_report", "--ongoing", "--action", "edit"],
      ["--to", "alice@example.com", "--artifact", "art_report", "--ongoing", "--notify"],
      // Combinations whose other flags would each fail first on their own.
      ["--ongoing", "--to", "not a target"],
      ["--ongoing", "--prefix"],
      ["--ongoing", "--artifact", "art_report", "--prefix", "--to", did],
      ["--ongoing", "--action", "bogus"],
      ["--ongoing", "--max-bytes", "0"],
    ];
    for (const flags of combinations) {
      const result = await refusal(["share", "publish", file, ...flags, "--json"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Ongoing shares are not available yet; v1 shares pin a version");
    }
    const multiple = await refusal(["share", "publish", file, await input(), "--ongoing", "--json"]);
    expect(multiple.stderr).toContain("Ongoing shares are not available yet; v1 shares pin a version");
    expect(published).toBe(0);
  });

  test("--ongoing is refused before stdin or any file is read", async () => {
    configureShareCommandServices({ targetAdapter: { publish: async () => { throw new Error("must not publish"); } } });
    const stdin = process.stdin as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> };
    const original = stdin[Symbol.asyncIterator];
    let read = false;
    stdin[Symbol.asyncIterator] = () => { read = true; throw new Error("stdin must not be read"); };
    try {
      const result = await refusal(["share", "publish", "-", "--name", "a.md", "--ongoing", "--json"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Ongoing shares are not available yet");
      const missing = await refusal(["share", "publish", "/nonexistent/never-read.md", "--ongoing", "--json"]);
      expect(missing.stderr).toContain("Ongoing shares are not available yet");
    } finally { stdin[Symbol.asyncIterator] = original; }
    expect(read).toBe(false);
  });

  test("--ongoing is not advertised in publish help", async () => {
    const program = new Command();
    registerShareCommand(program);
    const publish = program.commands.find((command) => command.name() === "share")?.commands.find((command) => command.name() === "publish");
    expect(publish?.helpInformation()).not.toContain("ongoing");
    expect(publish?.helpInformation()).toContain("--artifact");
  });

  test("refuses a malformed artifact id and more than one file", async () => {
    let published = 0;
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { published += 1; return publishedFor(request); } } });
    const file = await input();
    for (const id of ["../x", "A", "ab", "a b"]) {
      const result = await refusal(["share", "publish", file, "--artifact", id, "--json"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("artifact id");
    }
    const prefixed = await refusal(["share", "publish", file, "--to", did, "--prefix", "--artifact", "art_report", "--json"]);
    expect(prefixed.exitCode).toBe(2);
    expect(prefixed.stderr).toContain("does not combine with --prefix");
    const many = await refusal(["share", "publish", file, await input(), "--to", did, "--artifact", "art_report", "--json"]);
    expect(many.stderr).toContain("exactly one file");
    expect(published).toBe(0);
  });
});

describe("tc share versions", () => {
  function memory(): ArtifactStore {
    const data = new Map<string, Uint8Array>();
    return {
      async put(key, bytes) { if (data.has(key)) return "exists"; data.set(key, bytes.slice()); return "created"; },
      async get(key) { return data.get(key)?.slice(); },
      async list(prefix) { return [...data.keys()].filter((key) => key.startsWith(prefix)); },
    };
  }

  test("lists versions with the shares pinned to each, from local history", async () => {
    const store = memory();
    const enc = (value: string) => new TextEncoder().encode(value);
    await publishArtifactVersion(store, { artifactId: "art_report", files: [{ filename: "report.md", bytes: enc("one") }], note: "first" });
    await publishArtifactVersion(store, { artifactId: "art_report", files: [{ filename: "report.md", bytes: enc("two") }] });
    const records = new MemorySenderShareRecordStorage();
    const base = {
      target: { origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "owner-space" },
      actions: ["tinycloud.kv/get"] as const, recipientMatcher: { kind: "bearer" as const }, targetKind: "bearer" as const,
      registeredAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-10-25T00:00:00.000Z",
    };
    await records.put({ ...base, shareId: "share-on-v1", resource: { kind: "exact", path: "artifacts/art_report/versions/1/report.md" } });
    await records.put({ ...base, shareId: "share-other-artifact", resource: { kind: "exact", path: "artifacts/art_other/versions/1/report.md" } });
    await records.put({ ...base, shareId: "share-legacy", resource: { kind: "exact", path: "shares/abc/report.md" } });
    configureShareCommandServices({ artifactStore: async () => store, records });
    const result = await runShareCaptured(["share", "versions", "art_report", "--json"]);
    const body = JSON.parse(result.stdout) as { artifactId: string; versions: { version: number; note?: string; parent: number | null; pinnedShares: { shareId: string }[] }[] };
    expect(body.artifactId).toBe("art_report");
    expect(body.versions.map((entry) => [entry.version, entry.parent, entry.pinnedShares.map((share) => share.shareId)])).toEqual([[1, null, ["share-on-v1"]], [2, 1, []]]);
    expect(body.versions[0]?.note).toBe("first");
  });

  test("a corrupt manifest is marked and does not hide the other versions", async () => {
    const enc = (value: string) => new TextEncoder().encode(value);
    const data = new Map<string, Uint8Array>();
    const store: ArtifactStore = {
      async put(key, bytes) { if (data.has(key)) return "exists"; data.set(key, bytes.slice()); return "created"; },
      async get(key) { return data.get(key)?.slice(); },
      async list(prefix) { return [...data.keys()].filter((key) => key.startsWith(prefix)); },
    };
    await publishArtifactVersion(store, { artifactId: "art_report", files: [{ filename: "report.md", bytes: enc("one") }] });
    await publishArtifactVersion(store, { artifactId: "art_report", files: [{ filename: "report.md", bytes: enc("two") }] });
    data.set("artifacts/art_report/versions/1/manifest.json", enc("{truncated"));
    configureShareCommandServices({ artifactStore: async () => store });
    const result = await runShareCaptured(["share", "versions", "art_report", "--json"]);
    const body = JSON.parse(result.stdout) as { versions: { version: number; complete: boolean; corrupt?: boolean }[] };
    expect(body.versions.map((entry) => [entry.version, entry.complete, entry.corrupt === true])).toEqual([[1, false, true], [2, true, false]]);
    const human = await runShareCaptured(["share", "versions", "art_report"]);
    expect(human.stdout).toContain("v1\tcorrupt");
  });

  test("a denied listing gives the re-login hint publish gives", async () => {
    configureShareCommandServices({ artifactStore: async () => { throw new SharePublishAuthorityError({ kind: "scope-denied", capability: "artifact storage", requiredAction: "tinycloud.kv/list", localKey: false, profileName: "publisher" }); } });
    const result = await refusal(["share", "versions", "art_report", "--json"]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("auth login --device --manifest builtin:share-publishing");
    // The hint names the denied ability, so a profile without the `artifacts/` list grant knows what is missing.
    expect(result.stderr).toContain("(tinycloud.kv/list)");
  });
});
