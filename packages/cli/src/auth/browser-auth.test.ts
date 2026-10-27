import { describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { createServer, request, Server, type IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import {
  buildAuthUrl,
  callbackFlow,
  publicJwkForDelegation,
  startAuthFlow,
  validateDelegationCallbackPayload,
  type CallbackFlowEnv,
} from "./browser-auth.js";
import { CLIError, wrapError } from "../output/errors.js";

/** Run the paste flow with `chunks` as stdin. */
async function pasteWithStdin(chunks: string[], options: { did?: string; jwk?: object; openkeyApiHost?: string } = {}) {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from(chunks) });
  try {
    return await startAuthFlow(options.did ?? "did:key:z6MkDelegate", {
      paste: true, openkeyHost: "https://openkey.test", jwk: options.jwk, openkeyApiHost: options.openkeyApiHost,
    });
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
  test("looks up an eight-character code and rejects a result bound to another CLI key", async () => {
    const delegation = {
      delegationHeader: { Authorization: "Bearer signed" },
      delegationCid: "bafy",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:z6MkDelegate",
      jwk: { kty: "OKP", crv: "Ed25519", x: "public-key" },
    };
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ delegation }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const options = {
        openkeyApiHost: `http://127.0.0.1:${address.port}`,
        jwk: { ...delegation.jwk, d: "private-key" },
      };
      expect(await pasteWithStdin(["sf23-22cs\n"], options)).toEqual(delegation);
      // OpenKey shows codes in upper case; the lookup uses its lower-case canonical form.
      expect(await pasteWithStdin(["SF23-22CS\n"], options)).toEqual(delegation);
      expect(requests).toEqual(["/api/delegation-codes/sf23-22cs", "/api/delegation-codes/sf23-22cs"]);
      await expect(pasteWithStdin(["sf23-22cs\n"], { ...options, did: "did:key:z6MkOther" }))
        .rejects.toThrow(/different CLI key/);
      await expect(pasteWithStdin(["sf23-22cs\n"], { ...options, jwk: { ...delegation.jwk, x: "wrong-key" } }))
        .rejects.toThrow(/different CLI key/);
    } finally {
      server.close();
    }
  });

  test.each([
    [401, "AUTH_REQUIRED", 3],
    [403, "PERMISSION_DENIED", 5],
  ] as const)("delegation-code HTTP %i maps to %s from typed status", async (status, code, exitCode) => {
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end("unrelated response text");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const failure: unknown = await pasteWithStdin(["sf23-22cs\n"], {
        jwk: { kty: "OKP", crv: "Ed25519", x: "public-key" },
        openkeyApiHost: `http://127.0.0.1:${address.port}`,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        status,
        message: `Could not retrieve delegation code (HTTP ${status}).`,
      });
      expect(wrapError(failure)).toMatchObject({ code, exitCode });
    } finally {
      server.close();
    }
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
      input.end(`${JSON.stringify(code)}\n`);
      const result = await flow;
      expect(messages.join("\n")).toContain("https://openkey.test/delegate?");
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

  test("only OpenKey's origin, on the unguessable callback path, can deliver the delegation (TC-1058)", async () => {
    const code = {
      delegationHeader: { Authorization: "Bearer callback" },
      delegationCid: "bafy-callback",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    };
    const messages: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => { messages.push(args.join(" ")); });
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { configurable: true, value: new PassThrough() });
    let settled = false;
    let deliver: (() => Promise<Response>) | undefined;
    try {
      const flow = startAuthFlow("did:key:z6MkDelegate", { noPopup: true, openkeyHost: "https://openkey.test" })
        .finally(() => { settled = true; });
      while (!messages.some((message) => message.includes("/delegate?"))) await new Promise<void>((resolve) => setImmediate(resolve));
      const authUrl = new URL(messages.join(" ").match(/https:\/\/openkey\.test\/delegate\?\S+/)![0]);
      const callback = new URL(authUrl.searchParams.get("callback")!);
      expect(callback.pathname).toMatch(/^\/callback\/[\w-]{20,}$/);

      const send = (method: string, path: string, origin: string | undefined, body?: string) =>
        fetch(new URL(path, callback), {
          method,
          headers: { ...(origin === undefined ? {} : { Origin: origin }), "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body }),
        });
      deliver = () => send("POST", callback.pathname, "https://openkey.test", JSON.stringify(code));

      // OpenKey's preflight is what every real delivery starts with.
      const preflight = await send("OPTIONS", callback.pathname, "https://openkey.test");
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://openkey.test");
      expect(preflight.headers.get("access-control-allow-headers")).toBe("Content-Type");
      expect((await send("OPTIONS", callback.pathname, "https://attacker.test")).status).toBe(403);

      expect((await send("POST", "/callback", "https://openkey.test", JSON.stringify(code))).status).toBe(404);
      expect((await send("POST", callback.pathname, "https://attacker.test", JSON.stringify(code))).status).toBe(403);
      expect((await send("POST", callback.pathname, undefined, JSON.stringify(code))).status).toBe(403);
      expect((await send("POST", callback.pathname, "https://openkey.test", "{not json")).status).toBe(400);
      expect((await send("POST", callback.pathname, "https://openkey.test", "{}")).status).toBe(400);
      expect((await send("POST", callback.pathname, "https://openkey.test", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
      expect(settled).toBe(false);

      const accepted = await deliver();
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe("https://openkey.test");
      expect(await flow).toEqual(code);
    } finally {
      // A failed assertion must not leave the callback server and its timer running.
      if (!settled && deliver) await deliver().catch(() => undefined);
      error.mockRestore();
      if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    }
  });

  test.each([
    ["the browser login", false],
    ["the paste login", true],
  ])("Ctrl-C in a terminal cancels %s instead of waiting (TC-1062)", async (_label, paste) => {
    const input = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalStderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const messages: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => { messages.push(args.join(" ")); });
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    try {
      const flow = startAuthFlow("did:key:z6MkDelegate", { paste, noPopup: true, openkeyHost: "https://openkey.test" })
        .catch((failure: unknown) => failure);
      // Wait until the flow is reading the terminal.
      while (!messages.some((message) => message.includes("/delegate?"))) await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write("\x03");
      expect(await flow).toMatchObject({ code: "CANCELLED", exitCode: 130 });
    } finally {
      error.mockRestore();
      input.destroy();
      if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
      if (originalStderrTTY) Object.defineProperty(process.stderr, "isTTY", originalStderrTTY);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });
});

const OPENKEY = "https://openkey.test";
const HINT_PREFIX = "Still waiting.";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("browser callback wait", () => {
  const code = { delegationHeader: { Authorization: "Bearer wait" }, delegationCid: "bafy-wait", spaceId: "tinycloud:pkh:eip155:1:0xabc:default" };

  /** Start the callback flow and resolve once its callback URL is listening. */
  async function startWait(env: CallbackFlowEnv) {
    let onUrl!: (url: string) => void;
    const listening = new Promise<string>((resolve) => { onUrl = resolve; });
    const flow = callbackFlow("did:key:z6MkDelegate", { noPopup: true, openkeyHost: OPENKEY }, { ...env, onListening: onUrl });
    return { flow, callback: new URL(await listening) };
  }

  const deliver = (callback: URL) =>
    fetch(callback, {
      method: "POST",
      headers: { Origin: OPENKEY, "Content-Type": "application/json" },
      body: JSON.stringify(code),
    });

  /** Capture stderr lines and stub stdin so the interactive paste prompt never reads the test runner's input. */
  function captureTerminal(interactive: boolean) {
    const messages: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => { messages.push(args.join(" ")); });
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    if (interactive) Object.defineProperty(process, "stdin", { configurable: true, value: new PassThrough() });
    return {
      messages,
      hints: () => messages.filter((message) => message.startsWith(HINT_PREFIX)).length,
      restore: () => {
        error.mockRestore();
        if (stdin) Object.defineProperty(process, "stdin", stdin);
      },
    };
  }

  test("holds a POST the browser sends after 11 s, past the old 10 s request timeout", async () => {
    const terminal = captureTerminal(false);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 60_000, interactive: false });
      const body = JSON.stringify(code);
      const pending = request(callback, {
        method: "POST",
        headers: { Origin: OPENKEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      });
      pending.write(body.slice(0, 10));
      await sleep(11_000);
      pending.end(body.slice(10));
      const [response] = (await once(pending, "response")) as [IncomingMessage];
      response.resume();
      expect(response.statusCode).toBe(200);
      expect(await flow).toEqual(code);
    } finally {
      terminal.restore();
    }
  }, 30_000);

  test("the hold ends at the sign-in deadline, and a later callback is refused", async () => {
    const terminal = captureTerminal(false);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 300, interactive: false });
      await expect(flow).rejects.toThrow("Authentication timed out after 5 minutes");
      await expect(deliver(callback)).rejects.toThrow();
    } finally {
      terminal.restore();
    }
  });

  test("hands the approval URL (with its loopback callback) to onApprovalUrl before waiting", async () => {
    const terminal = captureTerminal(false);
    try {
      const urls: string[] = [];
      const { flow, callback } = await startWait({ deadlineMs: 60_000, interactive: false, onApprovalUrl: (url) => urls.push(url) });
      expect(urls).toHaveLength(1);
      const approval = new URL(urls[0]!);
      expect(approval.origin).toBe(OPENKEY);
      expect(approval.searchParams.get("callback")).toBe(callback.href);
      expect((await deliver(callback)).status).toBe(200);
      expect(await flow).toEqual(code);
    } finally {
      terminal.restore();
    }
  });

  test("with a timeout message, the deadline is a coded AUTH_TIMEOUT", async () => {
    const terminal = captureTerminal(false);
    try {
      const { flow } = await startWait({ deadlineMs: 200, interactive: false, timeoutMessage: "No approval arrived within 10 minutes." });
      await expect(flow).rejects.toMatchObject({ code: "AUTH_TIMEOUT", message: "No approval arrived within 10 minutes." });
    } finally {
      terminal.restore();
    }
  });

  test("prints the how-to once after the hint delay while interactive, and not again", async () => {
    const terminal = captureTerminal(true);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 1_000, hintDelayMs: 50, interactive: true, jsonOutput: false });
      await sleep(120);
      expect(terminal.hints()).toBe(1);
      await sleep(150);
      expect(terminal.hints()).toBe(1);
      expect((await deliver(callback)).status).toBe(200);
      await flow;
    } finally {
      terminal.restore();
    }
  });

  test("does not print the how-to once the callback has settled", async () => {
    const terminal = captureTerminal(true);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 1_000, hintDelayMs: 150, interactive: true, jsonOutput: false });
      expect((await deliver(callback)).status).toBe(200);
      await flow;
      await sleep(250);
      expect(terminal.hints()).toBe(0);
    } finally {
      terminal.restore();
    }
  });

  test("does not print the how-to in JSON output", async () => {
    const terminal = captureTerminal(true);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 1_000, hintDelayMs: 50, interactive: true, jsonOutput: true });
      await sleep(120);
      expect(terminal.hints()).toBe(0);
      expect((await deliver(callback)).status).toBe(200);
      await flow;
    } finally {
      terminal.restore();
    }
  });

  test("does not print the how-to when not interactive", async () => {
    const terminal = captureTerminal(false);
    try {
      const { flow, callback } = await startWait({ deadlineMs: 1_000, hintDelayMs: 50, interactive: false, jsonOutput: false });
      await sleep(120);
      expect(terminal.hints()).toBe(0);
      expect((await deliver(callback)).status).toBe(200);
      await flow;
    } finally {
      terminal.restore();
    }
  });
});
