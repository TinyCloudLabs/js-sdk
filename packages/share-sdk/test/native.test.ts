import { describe, expect, it } from "bun:test";
import { createNativeShare, openNativeShare, parseNativeShareUrl } from "../src/native.js";

describe("TinyCloud-native share adapter", () => {
  it("uses SharingService's tc1 token as the sole fragment-only bearer", async () => {
    const calls: unknown[] = [];
    const sharing = {
      generate: async (params: unknown) => { calls.push(params); return { ok: true as const, data: { token: "private-receiver-key-and-delegation", delegation: { cid: "bafy-native-delegation" }, expiresAt: new Date("2030-01-01T00:00:00Z") } }; },
      receive: async (token: string, options: unknown) => { calls.push({ token, options }); return { ok: true, data: { bytes: new Uint8Array([0, 1, 255]) } }; },
      decodeLink: () => ({ spaceId: "tinycloud:pkh:eip155:1:0xabc:applications", path: "applications/demo.bin" }),
    };
    const share = await createNativeShare(sharing, { path: "applications/demo.bin", expiresAt: new Date("2030-01-01T00:00:00Z"), viewerOrigin: "https://viewer.example" });
    expect(share).toEqual({ url: "https://viewer.example/viewer#tc1=private-receiver-key-and-delegation", delegationCid: "bafy-native-delegation", expiresAt: new Date("2030-01-01T00:00:00Z"), spaceId: "tinycloud:pkh:eip155:1:0xabc:applications" });
    expect(share.url.split("#")[0]).not.toContain("private");
    await expect(openNativeShare(sharing, share.url)).resolves.toEqual({ ok: true, data: { bytes: new Uint8Array([0, 1, 255]) } });
    expect(calls).toEqual([
      { path: "applications/demo.bin", actions: ["tinycloud.kv/get"], expiry: new Date("2030-01-01T00:00:00Z") },
      { token: "private-receiver-key-and-delegation", options: { autoSubdelegate: false, useSessionKey: false } },
    ]);
  });

  it("rejects path, query, mixed, and malformed legacy links", () => {
    for (const link of ["https://viewer.example/#tc1=tc1:secret", "https://viewer.example/share/tc1:secret", "https://viewer.example/?share=tc1:secret", "https://viewer.example/viewer?share=tc1:secret#tc1=tc1:secret", "https://viewer.example/viewer#tc1=tc1:secret&other=value", "https://viewer.example/viewer#tc-share=tc1:secret"]) {
      expect(() => parseNativeShareUrl(link)).toThrow("native share");
    }
  });
});
