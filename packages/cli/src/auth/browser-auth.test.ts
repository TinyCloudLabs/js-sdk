import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  buildAuthUrl,
  publicJwkForDelegation,
  startAuthFlow,
  validateDelegationCallbackPayload,
} from "./browser-auth.js";
import { CLIError } from "../output/errors.js";

/** Run the paste flow with `chunks` as stdin. */
async function pasteWithStdin(chunks: string[]) {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from(chunks) });
  try {
    return await startAuthFlow("did:key:z6MkDelegate", { paste: true, openkeyHost: "https://openkey.test" });
  } finally {
    if (stdin) Object.defineProperty(process, "stdin", stdin);
  }
}

function decodedJwkFromUrl(url: string): Record<string, unknown> {
  const encoded = new URL(url).searchParams.get("jwk");
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
}

describe("browser auth delegation URLs", () => {
  test("only sends public JWK fields to OpenKey", () => {
    const privateJwk = {
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
      d: "private-key",
      p: "rsa-prime",
      q: "rsa-prime",
      dp: "rsa-exponent",
      dq: "rsa-exponent",
      qi: "rsa-coefficient",
      oth: [{ r: "private" }],
      k: "symmetric-secret",
    };

    expect(publicJwkForDelegation(privateJwk)).toEqual({
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
    });

    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
      jwk: privateJwk,
    });

    expect(decodedJwkFromUrl(url)).toEqual({
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
    });
  });

  test("advertises versioned protocol via protocolVersion=1", () => {
    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
    });
    expect(new URL(url).searchParams.get("protocolVersion")).toBe("1");
  });

  test("validateDelegationCallbackPayload accepts a well-formed response", () => {
    const good = {
      delegationHeader: { Authorization: "Bearer x" },
      delegationCid: "bafy",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    };
    expect(validateDelegationCallbackPayload(good)).toBeNull();
  });

  test("validateDelegationCallbackPayload rejects missing fields", () => {
    expect(validateDelegationCallbackPayload(null)).toContain("expected");
    expect(validateDelegationCallbackPayload({})).toContain("delegationHeader");
    expect(
      validateDelegationCallbackPayload({
        delegationHeader: { Authorization: "" },
        delegationCid: "cid",
        spaceId: "space",
      }),
    ).toContain("Authorization");
  });

  test("includes permission request reason for OpenKey consent", () => {
    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
      reason: "Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.",
      permissions: [
        {
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/DEPLOY_KEY",
          actions: ["tinycloud.kv/get"],
        },
      ],
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("reason")).toBe(
      "Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.",
    );

    const payload = JSON.parse(
      Buffer.from(parsed.searchParams.get("permissions")!, "base64url").toString("utf8"),
    );
    expect(payload.reason).toBe("Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.");
    expect(payload.permissions).toHaveLength(1);
  });
});

describe("paste login", () => {
  const code = { delegationHeader: { Authorization: "Bearer x" }, delegationCid: "bafy", spaceId: "tinycloud:pkh:eip155:1:0xabc:secrets" };

  test("accepts a code whose final line has no newline", async () => {
    expect(await pasteWithStdin([JSON.stringify(code)])).toEqual(code);
    expect(await pasteWithStdin(["\n", Buffer.from(JSON.stringify(code)).toString("base64"), "\n"])).toEqual(code);
  });

  test("fails non-zero and names the approval URL when stdin ends without a code", async () => {
    const failure = await pasteWithStdin([]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CLIError);
    if (!(failure instanceof CLIError)) return;
    expect(failure).toMatchObject({ code: "PASTE_CODE_MISSING", exitCode: 3 });
    const approvalUrl = String(failure.metadata?.approvalUrl);
    expect(approvalUrl).toStartWith("https://openkey.test/delegate?");
    expect(failure.message).toContain(approvalUrl);
  });
});
