import { describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { Server } from "node:http";
import { PassThrough, Readable } from "node:stream";
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

describe("browser callback login", () => {
  test("shows the URL on stderr and accepts paste when stdout is redirected", async () => {
    const code = {
      delegationHeader: { Authorization: "Bearer pasted" },
      delegationCid: "bafy-pasted",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:secrets",
    };
    const callbackCode = { ...code, delegationCid: "bafy-callback" };
    const input = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const originalStderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const messages: string[] = [];
    let callbackServer: Server | undefined;
    const originalListen = Server.prototype.listen;
    const listen = spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
      callbackServer = this;
      return Reflect.apply(originalListen, this, args);
    });
    const error = spyOn(console, "error").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    try {
      const flow = startAuthFlow("did:key:z6MkDelegate", {
        noPopup: true,
        openkeyHost: "https://openkey.test",
      });
      if (!callbackServer) throw new Error("Callback server did not start");
      await once(callbackServer, "listening");
      // Let the listen callback install the paste reader before providing input.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let result: typeof code;
      if (messages.some((message) => message.includes("paste the delegation code here"))) {
        input.end(`${JSON.stringify(code)}\n`);
        result = await flow;
      } else {
        // The pre-fix flow never offers paste. Complete its actual HTTP callback
        // so the test fails promptly rather than leaving a five-minute timer.
        const addr = callbackServer.address();
        if (!addr || typeof addr === "string") throw new Error("Callback server did not start");
        const response = await fetch(`http://127.0.0.1:${addr.port}/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(callbackCode),
        });
        expect(response.ok).toBe(true);
        result = await flow;
      }
      expect(messages.join("\n")).toContain("https://openkey.test/delegate?");
      expect(messages.join("\n")).toContain("paste the delegation code here");
      expect(result).toEqual(code);
      expect(callbackServer.listening).toBe(false);
    } finally {
      listen.mockRestore();
      error.mockRestore();
      input.destroy();
      if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
      if (originalStdoutTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutTTY);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      if (originalStderrTTY) Object.defineProperty(process.stderr, "isTTY", originalStderrTTY);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });
});
