import { describe, expect, it } from "bun:test";
import { inspectShare, publishShare, receiveShare, SharePublishError } from "../src/index.js";

describe("publishShare", () => {
  it("round-trips compact and inline bearer links through the shared verifier", async () => {
    const blobs = new Map<string, Uint8Array>();
    const upload = async (input: { cid: string; blob: Uint8Array; deleteAfter: string; contentLength: number }) => {
      blobs.set(input.cid, input.blob.slice());
      return { cid: input.cid, deleteAfter: input.deleteAfter };
    };
    const options = {
      source: new TextEncoder().encode("# decision\n\nbounded markdown\n"),
      filename: "decision.md",
      origin: "https://share.tinycloud.xyz",
      now: () => Date.parse("2026-07-01T00:00:00.000Z"),
      uploadBlob: upload,
      fetchBlob: async ({ cid }: { readonly cid: string }) => blobs.get(cid)!,
    };
    const compact = await publishShare(options);
    const compactInspection = await inspectShare(compact.url, options);
    expect(compactInspection.metadata.display.filename).toBe("decision.md");
    expect((await receiveShare(compact.url, options)).text).toBe("# decision\n\nbounded markdown\n");
    expect(JSON.stringify(compact.metadata)).not.toContain("sessionJwk");
    expect(JSON.stringify(compact.metadata)).not.toContain("content.key");

    const inline = await publishShare({ ...options, inline: true });
    expect((await receiveShare(inline.url, options)).text).toBe("# decision\n\nbounded markdown\n");
    expect(inline.link.kind).toBe("inline");
  });

  it("requires upload authority for a production registry", async () => {
    await expect(publishShare({
      source: new TextEncoder().encode("# no anonymous upload\n"),
      filename: "no-anonymous.md",
      origin: "https://share.tinycloud.xyz",
      registryBaseUrl: "https://registry.tinycloud.xyz",
      now: () => Date.parse("2026-07-01T00:00:00.000Z"),
    })).rejects.toBeInstanceOf(SharePublishError);
    await expect(publishShare({
      source: new TextEncoder().encode("# no anonymous upload\n"),
      filename: "no-anonymous.md",
      origin: "https://share.tinycloud.xyz",
      registryBaseUrl: "https://registry.tinycloud.xyz",
      now: () => Date.parse("2026-07-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "upload-auth-required" });
  });

  it("bounds async stdin-shaped sources before upload", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(3);
      yield new Uint8Array(4);
    }
    await expect(publishShare({
      source: source(),
      filename: "too-large.md",
      origin: "https://share.tinycloud.xyz",
      maxBytes: 6,
      uploadBlob: async () => { throw new Error("must not upload"); },
    })).rejects.toMatchObject({ code: "max-bytes-exceeded" });
  });
});
