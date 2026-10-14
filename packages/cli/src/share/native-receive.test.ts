import { describe, expect, it } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { createShareAuthorityAdapters } from "./adapters.js";

const link = "https://share.example/viewer#tc1=tc1:opaque";

function readerFor(readError: { readonly code: string; readonly message: string; readonly meta: Record<string, unknown> } | undefined) {
  // Only the members nativeReader touches; the real SharingService is much wider.
  const sharing = {
    decodeLink: () => ({ host: "http://127.0.0.1:8000" }),
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
    expect(failure).toMatchObject({ code: "SHARE_REVOKED", message: "This share link has been revoked by its sender.", exitCode: 4 });
  });

  it("keeps other read refusals generic", async () => {
    const failure = await readerFor({ code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - Unauthorized Action: space/kv/x / tinycloud.kv/get', meta: { status: 401 } })(link)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CLIError);
    expect(failure).toMatchObject({ message: "native share content could not be read" });
  });

  it("returns the shared bytes when the read succeeds", async () => {
    const received = await readerFor(undefined)(link);
    expect(new TextDecoder().decode(received.bytes)).toBe("# report\n");
    expect(received.filename).toBe("report.md");
  });
});
