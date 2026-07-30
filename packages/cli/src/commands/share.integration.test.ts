import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureShareCommandServices, registerShareCommand } from "./share.js";
import { MemorySenderShareRecordStorage } from "@tinycloud/share-sdk";

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
});
