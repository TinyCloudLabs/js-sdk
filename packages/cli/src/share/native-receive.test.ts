import { describe, expect, it } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { createShareAuthorityAdapters } from "./adapters.js";

const link = "https://share.example/viewer#tc1=tc1:opaque";

function readerFor(readError: { readonly code: string; readonly message: string; readonly meta: Record<string, unknown> } | undefined) {
  // Only the members nativeReader touches; the real SharingService is much wider.
  const sharing = {
    receive: async () => ({
      ok: true as const,
      data: {
        path: "xyz.tinycloud.share/shares/report.md",
        kv: {
          get: async () => readError === undefined
            ? { ok: true as const, data: { data: new TextEncoder().encode("# report\n") } }
            : { ok: false as const, error: { ...readError, service: "kv" } },
        },
      },
    }),
  } as unknown as TinyCloudNode["sharing"];
  return createShareAuthorityAdapters({ nativeSharing: () => sharing }).nativeReader;
}

describe("native bearer receive", () => {
  it("reports a link the node refuses as revoked with SHARE_REVOKED (exit 4)", async () => {
    const failure = await readerFor({ code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - delegation-revoked: bafyreirevokedleaf\n', meta: { status: 401 } })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure).toMatchObject({ code: "SHARE_REVOKED", exitCode: 4 });
  });

  it("keeps other read refusals generic", async () => {
    const failure = await readerFor({ code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - Unauthorized Action: space/kv/x / tinycloud.kv/get', meta: { status: 401 } })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CLIError);
  });

  it("uses the final shared path segment as the download filename", async () => {
    const received = await readerFor(undefined)(link);
    expect(received.filename).toBe("report.md");
  });
});
