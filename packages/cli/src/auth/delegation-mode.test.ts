import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  DELEGATION_MODE_KEY,
  TERMINAL_REDELEGATION_REFUSED_MESSAGE,
  makePkhSpaceId,
  withSiweDelegationMode,
} from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { buildAuthUrl } from "./browser-auth.js";
import { verifyScopedLogin, verifySignedSession } from "./scoped-login.js";
import { cliErrorFromService, wrapError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const ownerAccount = privateKeyToAccount(`0x${OWNER_KEY}`);

async function buildSignedSessionData(mutateRecapJson?: (json: string) => string) {
  const wasm = new NodeWasmBindings();
  const spaceId = makePkhSpaceId(ownerAccount.address, 1, "default");
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": ["tinycloud.kv/get"] } },
    address: ownerAccount.address,
    chainId: 1,
    domain: "openkey.test",
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 3600_000).toISOString(),
    spaceId,
  });
  let siwe = prepared.siwe;
  if (mutateRecapJson) {
    const match = siwe.match(/- urn:recap:([A-Za-z0-9_-]+)$/)!;
    const origJson = Buffer.from(match[1]!, "base64url").toString("utf8");
    const nextJson = mutateRecapJson(origJson);
    siwe = siwe.slice(0, -match[0].length) + `- urn:recap:${Buffer.from(nextJson, "utf8").toString("base64url")}`;
  }
  const signature = await ownerAccount.signMessage({ message: siwe });
  const completed = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  return {
    data: {
      delegationHeader: completed.delegationHeader,
      delegationCid: completed.delegationCid,
      spaceId,
      address: ownerAccount.address,
      chainId: 1,
      siwe,
      signature,
      verificationMethod: prepared.verificationMethod,
    },
    jwk: prepared.jwk,
    sessionDid: prepared.verificationMethod,
  };
}

describe("TC-3810 CLI delegationMode declarations, validation, and refusal copy", () => {
  test("buildAuthUrl includes delegationMode when specified and omits it when absent", () => {
    const did = "did:key:z6MkTestDid";
    const withAttenuable = new URL(buildAuthUrl(did, { delegationMode: "attenuable" }));
    expect(withAttenuable.searchParams.get("delegationMode")).toBe("attenuable");

    const withTerminal = new URL(buildAuthUrl(did, { delegationMode: "terminal" }));
    expect(withTerminal.searchParams.get("delegationMode")).toBe("terminal");

    const withoutMode = new URL(buildAuthUrl(did, {}));
    expect(withoutMode.searchParams.has("delegationMode")).toBe(false);
  });

  test("verifySignedSession accepts terminal, attenuable, and absent modes", async () => {
    for (const mode of ["terminal", "attenuable", undefined] as const) {
      const built = await buildSignedSessionData(
        mode === undefined
          ? undefined
          : (json) => {
              const obj = JSON.parse(json);
              return JSON.stringify({ att: obj.att, prf: obj.prf, [DELEGATION_MODE_KEY]: mode });
            },
      );
      const signed = verifySignedSession(built.data, built.jwk, built.sessionDid);
      expect(signed.ownerDid.toLowerCase()).toBe(`did:pkh:eip155:1:${ownerAccount.address.toLowerCase()}`);
    }
  });

  test.each([
    ["null", (json: string) => json.replace(/\}$/, `,"${DELEGATION_MODE_KEY}":null}`)],
    ["unknown string", (json: string) => json.replace(/\}$/, `,"${DELEGATION_MODE_KEY}":"other"}`)],
    ["number", (json: string) => json.replace(/\}$/, `,"${DELEGATION_MODE_KEY}":42}`)],
    ["duplicate escaped key", (json: string) => json.replace(/\}$/, `,"${DELEGATION_MODE_KEY}":"terminal","\\u0078yz.tinycloud.policy/delegationMode":"attenuable"}`)],
  ])("verifySignedSession refuses malformed delegationMode (%s)", async (_label, mutate) => {
    const built = await buildSignedSessionData(mutate);
    expect(() => verifySignedSession(built.data, built.jwk, built.sessionDid)).toThrow();
  });

  test("verifySignedSession accepts absent on /a/ and attenuable paths, refuses absent or flipped on declared terminal, and refuses flipped on declared attenuable", async () => {
    const absent = await buildSignedSessionData();
    const terminal = await buildSignedSessionData((json) => {
      const obj = JSON.parse(json);
      return JSON.stringify({ att: obj.att, prf: obj.prf, [DELEGATION_MODE_KEY]: "terminal" });
    });
    const attenuable = await buildSignedSessionData((json) => {
      const obj = JSON.parse(json);
      return JSON.stringify({ att: obj.att, prf: obj.prf, [DELEGATION_MODE_KEY]: "attenuable" });
    });

    // /a/ login (no expected.delegationMode): absent, terminal, and attenuable all pass.
    const requested = [{ service: "tinycloud.kv", space: absent.data.spaceId, path: "", actions: ["tinycloud.kv/get"] }];
    expect(verifyScopedLogin(absent.data, absent.jwk, absent.sessionDid, requested).session.ownerDid.toLowerCase()).toBe(
      `did:pkh:eip155:1:${ownerAccount.address.toLowerCase()}`,
    );
    expect(verifyScopedLogin(terminal.data, terminal.jwk, terminal.sessionDid, requested).session.ownerDid.toLowerCase()).toBe(
      `did:pkh:eip155:1:${ownerAccount.address.toLowerCase()}`,
    );

    // Declared attenuable: absent stays accepted (legacy-attenuable / pre-#735 OpenKey), attenuable passes, terminal is refused.
    expect(verifySignedSession(absent.data, absent.jwk, absent.sessionDid, { delegationMode: "attenuable" }).ownerDid).toBeTruthy();
    expect(verifySignedSession(attenuable.data, attenuable.jwk, attenuable.sessionDid, { delegationMode: "attenuable" }).ownerDid).toBeTruthy();
    expect(() =>
      verifySignedSession(terminal.data, terminal.jwk, terminal.sessionDid, { delegationMode: "attenuable" }),
    ).toThrow(/OpenKey returned a terminal grant when attenuable was requested/);

    // Declared terminal: fail-closed — ONLY terminal passes; absent and attenuable are both refused.
    expect(verifySignedSession(terminal.data, terminal.jwk, terminal.sessionDid, { delegationMode: "terminal" }).ownerDid).toBeTruthy();
    expect(() =>
      verifySignedSession(absent.data, absent.jwk, absent.sessionDid, { delegationMode: "terminal" }),
    ).toThrow(/OpenKey returned an undeclared grant when terminal was requested/);
    expect(() =>
      verifySignedSession(attenuable.data, attenuable.jwk, attenuable.sessionDid, { delegationMode: "terminal" }),
    ).toThrow(/OpenKey returned an attenuable grant when terminal was requested/);
  });

  test("withSiweDelegationMode round-trips cleanly through verifySignedSession", async () => {
    const wasm = new NodeWasmBindings();
    const spaceId = makePkhSpaceId(ownerAccount.address, 1, "default");
    const prepared = wasm.prepareSession({
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      address: ownerAccount.address,
      chainId: 1,
      domain: "openkey.test",
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 3600_000).toISOString(),
      spaceId,
    });
    const siwe = withSiweDelegationMode(prepared.siwe, "attenuable");
    const signature = await ownerAccount.signMessage({ message: siwe });
    const completed = wasm.completeSessionSetup({ ...prepared, siwe, signature });
    const signed = verifySignedSession(
      {
        delegationHeader: completed.delegationHeader,
        delegationCid: completed.delegationCid,
        spaceId,
        address: ownerAccount.address,
        chainId: 1,
        siwe,
        signature,
        verificationMethod: prepared.verificationMethod,
      },
      prepared.jwk,
      prepared.verificationMethod,
    );
    expect(signed.permissions.length).toBeGreaterThan(0);
  });

  test("CLI error mapping renders Monica's terminal refusal message cleanly", () => {
    const fromWrap = wrapError(new Error("401 - terminal-parent-cannot-redelegate"));
    expect(fromWrap.code).toBe("TERMINAL_DELEGATION_REFUSED");
    expect(fromWrap.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(fromWrap.message).toBe(TERMINAL_REDELEGATION_REFUSED_MESSAGE);

    const fromService = cliErrorFromService({
      code: "AUTH_REQUIRED",
      message: "terminal-parent-cannot-redelegate",
      status: 401,
    });
    expect(fromService.code).toBe("TERMINAL_DELEGATION_REFUSED");
    expect(fromService.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(fromService.message).toBe(TERMINAL_REDELEGATION_REFUSED_MESSAGE);
  });
});
