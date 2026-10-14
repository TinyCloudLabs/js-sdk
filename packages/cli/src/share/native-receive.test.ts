import { describe, expect, it, mock } from "bun:test";
import { CLIError } from "../output/errors.js";

let readError: { readonly code: string; readonly message: string; readonly service: string; readonly meta?: Record<string, unknown> } | undefined;

mock.module("@tinycloud/node-sdk", () => ({
  TinyCloudNode: class {
    readonly sharing = {
      decodeLink: () => ({ host: "http://127.0.0.1:8000" }),
      receive: async () => ({
        ok: true as const,
        data: {
          path: "xyz.tinycloud.share/shares/report.md",
          kv: {
            get: async () => readError === undefined
              ? { ok: true as const, data: { data: new TextEncoder().encode("# report\n") } }
              : { ok: false as const, error: readError },
          },
        },
      }),
    };
  },
}));

// Imported after mock.module so the adapter loads the fake node SDK.
const { createShareAuthorityAdapters } = await import("./adapters.js");
const link = "https://share.example/viewer#tc1=tc1:opaque";

describe("native bearer receive", () => {
  it("reports a link the node refuses as revoked with SHARE_REVOKED (exit 4)", async () => {
    readError = { code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - delegation-revoked: bafyreirevokedleaf\n', service: "kv", meta: { status: 401 } };
    const failure = await createShareAuthorityAdapters().nativeReader(link).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure).toMatchObject({ code: "SHARE_REVOKED", message: "This share link has been revoked by its sender.", exitCode: 4 });
  });

  it("keeps other read refusals generic", async () => {
    readError = { code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - Unauthorized Action: space/kv/x / tinycloud.kv/get', service: "kv", meta: { status: 401 } };
    const failure = await createShareAuthorityAdapters().nativeReader(link).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CLIError);
    expect(failure).toMatchObject({ message: "native share content could not be read" });
  });

  it("returns the shared bytes when the read succeeds", async () => {
    readError = undefined;
    const received = await createShareAuthorityAdapters().nativeReader(link);
    expect(new TextDecoder().decode(received.bytes)).toBe("# report\n");
    expect(received.filename).toBe("report.md");
  });
});
