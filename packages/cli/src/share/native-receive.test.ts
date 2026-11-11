import { describe, expect, it } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { NodeNotFoundError } from "@tinycloud/sdk-core";
import { createShareAuthorityAdapters } from "./adapters.js";

const link = "https://share.example/viewer#tc1=tc1:opaque";

function readerFor(readError: { readonly code: string; readonly message: string; readonly meta: Record<string, unknown>; readonly cause?: unknown } | undefined) {
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

  it("explains verified absence of the sender's storage settings without retrying", async () => {
    const subject = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
    const cause = new NodeNotFoundError(subject, { status: "unregistered", subject, source: "offchain", hosts: [] });
    const failure = await readerFor({ code: cause.code, message: cause.message, cause, meta: {} })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure).toMatchObject({ code: "SHARE_SENDER_UNREGISTERED", exitCode: 4 });
  });

  it.each([
    { status: "registered", subject: "did:key:z6MkSender", source: "offchain", hosts: [] },
    { status: "unregistered", subject: "did:key:z6MkSender", source: "offchain", hosts: [], offline: true },
  ] as const)("does not turn registered or offline refusal into a publication request: %j", async (verdict) => {
    const cause = new NodeNotFoundError(verdict.subject, verdict);
    const failure = await readerFor({ code: cause.code, message: cause.message, cause, meta: {} })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CLIError);
  });

  it.each(["registry_unavailable", "AUTH_UNAUTHORIZED", "RESOURCE_NOT_ROUTED"])("keeps %s distinct from unpublished storage settings", async (code) => {
    const failure = await readerFor({ code, message: "sender has not published", meta: {} })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CLIError);
  });

  it("keeps other read refusals generic", async () => {
    const failure = await readerFor({ code: "AUTH_UNAUTHORIZED", message: 'Failed to get key "": 401 - Unauthorized Action: space/kv/x / tinycloud.kv/get', meta: { status: 401 } })(link)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CLIError);
  });

  it("returns the shared file's basename when the read succeeds", async () => {
    const received = await readerFor(undefined)(link);
    expect(received.filename).toBe("report.md");
  });
});
