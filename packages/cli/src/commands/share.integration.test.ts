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

  test("refuses control and invisible filenames with UNSAFE_FILENAME before reading or publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-unsafe-name-"));
    const input = join(root, "report.md");
    await writeFile(input, "# unsafe name\n", "utf8");
    let published = 0;
    configureShareCommandServices({ targetAdapter: { publish: async () => { published += 1; throw new Error("must not publish"); } } });
    // handleError ends the process; record its exit code and let the action return instead.
    const refusal = async (args: readonly string[]): Promise<{ exitCode: number | undefined; stderr: string }> => {
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
      try {
        const { stderr } = await runShareCaptured(args);
        return { exitCode, stderr };
      }
      finally { process.exit = originalExit; }
    };
    for (const name of ["a\u0001.md", "a\u200B.md", "a\u202E.md", "a\u2028.md"]) {
      const result = await refusal(["share", "publish", input, "--name", name, "--json"]);
      expect(result.exitCode).toBe(8);
      expect(result.stderr).toContain("UNSAFE_FILENAME");
    }
    const stdin = process.stdin as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> };
    const originalIterator = stdin[Symbol.asyncIterator];
    let stdinRead = false;
    stdin[Symbol.asyncIterator] = () => { stdinRead = true; throw new Error("stdin must not be read"); };
    try {
      const result = await refusal(["share", "publish", "-", "--name", "a\u200B.md", "--json"]);
      expect(result.exitCode).toBe(8);
      expect(result.stderr).toContain("UNSAFE_FILENAME");
    } finally {
      stdin[Symbol.asyncIterator] = originalIterator;
    }
    expect(stdinRead).toBe(false);
    expect(published).toBe(0);
  });
});
