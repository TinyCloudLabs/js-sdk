import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { postAddressedShareDelivery } from "./adapters.js";

describe("TinyCloud share authority adapter", () => {
  it("routes addressed delivery through Policy/v3 with no retired Node delivery fallback", async () => {
    const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
    expect(source).toContain("node.authorizeShareDeliveryV3({");
    expect(source).not.toContain("node.authorizeShareDelivery({");
    expect(source).not.toContain("/share/v2/deliveries/authorize");
  });

  it("uses the existing signed Policy/v3 root revocation primitive for addressed shares", async () => {
    const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
    expect(source).toContain("revokePolicyRootV3({");
    expect(source).toContain("revokePolicyRoot: input.revokePolicyRoot");
    expect(source).toContain('reason: "share revoked"');
    expect(source).not.toContain("/share/v2/revoke");
  });

  it("posts the exact signed delivery receipt only to api.share", async () => {
    const emailOrigin = "https://email.example";
    const request = { returnLink: "https://share.example/viewer?tc2=public-policy" };
    const admission = { schema: "xyz.tinycloud.policy/delivery-admission/v0" };
    const proof = { alg: "EdDSA", kid: "did:web:node.example#key", signature: "test-signature" };
    const shareUrl = request.returnLink;
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];

    const response = await postAddressedShareDelivery({
      emailOrigin,
      receipt: { request, admission, proof },
      shareUrl,
      fetchFn: (async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 202 });
      }) as typeof globalThis.fetch,
    });

    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${emailOrigin}/v1/email`);
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init).not.toHaveProperty("referrer");
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ request, admission, proof });
    expect(Object.keys(body).sort()).toEqual(["admission", "proof", "request"]);
  });

});
