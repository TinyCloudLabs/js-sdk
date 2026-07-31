import { describe, expect, it } from "bun:test";
import { createProductionUploadAuthorizer } from "./adapters.js";

const upload = {
  blob: new Uint8Array([1, 2, 3]),
  cid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  deleteAfter: "2030-01-01T00:00:00.000Z",
  contentLength: 3,
};

describe("Share upload authority adapter", () => {
  it("uses an explicit noninteractive acquisition hook without reading or persisting a private JWK", async () => {
    let received: string | undefined;
    const authorize = createProductionUploadAuthorizer({
      profileName: async () => "openkey-profile",
      acquireUploadAuthorization: async (input) => {
        received = input.profileName;
        expect(input.upload.cid).toBe(upload.cid);
        return { cookie: "share_session_opaque" };
      },
    });

    await expect(authorize(upload)).resolves.toEqual({ cookie: "share_session_opaque" });
    expect(received).toBe("openkey-profile");
  });

  it("accepts an already host-issued session as the resumable authority", async () => {
    const authorize = createProductionUploadAuthorizer({
      profileName: async () => "openkey-profile",
      sessionAuthorization: async () => ({ cookie: "share_session_opaque" }),
    });
    await expect(authorize(upload)).resolves.toEqual({ cookie: "share_session_opaque" });
  });
});
