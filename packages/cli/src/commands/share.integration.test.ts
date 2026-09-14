import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";
import { MemorySenderShareRecordStorage, type PublishedShare } from "@tinycloud/share-sdk";

describe("tc share command integration", () => {
  test("publishes, receives, and records one native TinyCloud bearer link", async () => {
    const viewerOrigin = "https://share-dev.tinycloud.link";
    const root = await mkdtemp(join(tmpdir(), "tc-share-command-"));
    const input = join(root, "report.md");
    const output = join(root, "received");
    await writeFile(input, "# command round trip\n", "utf8");
    const records = new MemorySenderShareRecordStorage();
    const bytes = new TextEncoder().encode("# command round trip\n");
    const link = `${viewerOrigin}/viewer#tc1=opaque-native-delegation`;
    configureShareCommandServices({
      records,
      targetAdapter: { publish: async (input) => ({
        protocol: "tinycloud-share", version: 1, url: link,
        link: { kind: "native", cid: "bafy-native-delegation" },
        metadata: {
          protocol: "tinycloud-share", version: 1, shareId: "bafy-native-delegation", origin: viewerOrigin,
          target: { kind: "bearer", origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "owner-space" },
          resource: { kind: "exact", path: `xyz.tinycloud.share/shares/id/${input.filename}` }, actions: ["read"],
          expiresAt: input.expiresAt.toISOString(), display: { filename: input.filename }, recipientMatcher: { kind: "bearer" },
          enforcementDelegationCid: "bafy-native-delegation",
        },
      } satisfies PublishedShare) },
      nativeReader: async () => ({ bytes, filename: "report.md" }),
    });

    expect((await runShareCaptured(["share", "publish", input, "--viewer-origin", viewerOrigin])).stdout.trim()).toBe(link);
    const receivedPath = (await runShareCaptured(["share", "receive", link, "--output", output, "--viewer-origin", viewerOrigin])).stdout.trim();
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

    const childPath = fileURLToPath(new URL("./share.integration.outer.ts", import.meta.url));
    const child = spawn(process.execPath, [childPath], { cwd: dirname(childPath), stdio: ["ignore", "pipe", "pipe"] });
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });
});
