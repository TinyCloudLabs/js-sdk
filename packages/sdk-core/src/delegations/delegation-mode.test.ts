import { describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import {
  DELEGATION_MODE_KEY,
  TERMINAL_REDELEGATION_REFUSED_MESSAGE,
  extractSiweDelegationMode,
  isTerminalParentRefusal,
  withSiweDelegationMode,
} from "./terminal";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import { checkChangedExpiration, extractRecapAttenuations } from "../authorization/openkey-protocol";
import fixture from "../../test-fixtures/siwe-cacao/owner-share.json";

const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const toBytes = (authorization: string) => new Uint8Array(Buffer.from(authorization, "base64url"));
const toAuthorization = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const b64u = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const RESOURCE = fixture.delegation.resource;
const STATEMENT =
  `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.kv': 'get' for '${RESOURCE}'.`;

function makeSiwe(rawRecapJson: string, overrides: { expirationTime?: string } = {}): string {
  return new SiweMessage({
    domain: "example.com",
    address: owner.address,
    statement: STATEMENT,
    uri: fixture.delegation.audience,
    version: "1",
    chainId: 1,
    nonce: "abcd1234",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expirationTime: overrides.expirationTime ?? "2026-02-01T00:00:00.000Z",
    resources: [`urn:recap:${b64u(rawRecapJson)}`],
  }).prepareMessage();
}

async function signCacaoWithRawRecap(rawRecapJson: string): Promise<{ authorization: string; siwe: string }> {
  const resource = `urn:recap:${b64u(rawRecapJson)}`;
  const payload = {
    domain: "example.com",
    iss: fixture.ownerDid,
    aud: fixture.delegation.audience,
    version: 1,
    nonce: "abcd1234",
    iat: "2026-01-01T00:00:00.000Z",
    exp: "2026-02-01T00:00:00.000Z",
    statement: STATEMENT,
    resources: [resource],
  };
  const siwe = makeSiwe(rawRecapJson);
  const signature = await owner.signMessage({ message: siwe });
  const authorization = toAuthorization(
    encodeDagCbor({
      h: { t: "eip4361" },
      p: payload,
      s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) },
    }),
  );
  return { authorization, siwe };
}

describe("TC-3810 ReCap delegationMode parsing and construction", () => {
  test("parses terminal, explicit attenuable, and absent (legacy attenuable) in CACAO and SIWE", async () => {
    const base = { att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } }, prf: [] };

    const terminal = await signCacaoWithRawRecap(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }));
    expect(extractSiweDelegationMode(terminal.siwe)).toBe("terminal");
    expect((await parseSignedSiweCacao(terminal.authorization)).delegationMode).toBe("terminal");

    const attenuable = await signCacaoWithRawRecap(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "attenuable" }));
    expect(extractSiweDelegationMode(attenuable.siwe)).toBe("attenuable");
    expect((await parseSignedSiweCacao(attenuable.authorization)).delegationMode).toBe("attenuable");

    const absent = await signCacaoWithRawRecap(JSON.stringify(base));
    expect(extractSiweDelegationMode(absent.siwe)).toBeUndefined();
    const parsedAbsent = await parseSignedSiweCacao(absent.authorization);
    expect(parsedAbsent.delegationMode).toBeUndefined();
    expect("delegationMode" in parsedAbsent).toBe(false);
  });

  test.each([
    ["null", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":null}`],
    ["unknown string", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":"Terminal"}`],
    ["empty string", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":""}`],
    ["number", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":1}`],
    ["boolean", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":true}`],
    ["array", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":["terminal"]}`],
    ["object", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":{"mode":"terminal"}}`],
    ["duplicate key (terminal then attenuable)", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","${DELEGATION_MODE_KEY}":"attenuable"}`],
    ["duplicate key (attenuable then terminal)", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":"attenuable","${DELEGATION_MODE_KEY}":"terminal"}`],
    ["duplicate key (identical values)", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","${DELEGATION_MODE_KEY}":"terminal"}`],
    ["duplicate key (escaped-name equivalent)", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","\\u0078yz.tinycloud.policy/delegationMode":"attenuable"}`],
    ["duplicate key (escaped first)", `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}]}},"prf":[],"\\u0078yz.tinycloud.policy/delegationMode":"attenuable","${DELEGATION_MODE_KEY}":"terminal"}`],
  ])("refuses %s in parseSignedSiweCacao, extractSiweDelegationMode, and extractRecapAttenuations", async (_label, rawJson) => {
    const { authorization, siwe } = await signCacaoWithRawRecap(rawJson);
    await expect(parseSignedSiweCacao(authorization)).rejects.toThrow();
    expect(() => extractSiweDelegationMode(siwe)).toThrow();
    expect(() => extractRecapAttenuations(siwe)).toThrow();
  });

  test("refuses arbitrary unknown top-level ReCap fields while allowing delegationMode", async () => {
    const rawJson = JSON.stringify({
      att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } },
      prf: [],
      [DELEGATION_MODE_KEY]: "terminal",
      extra: "nope",
    });
    const { authorization, siwe } = await signCacaoWithRawRecap(rawJson);
    await expect(parseSignedSiweCacao(authorization)).rejects.toThrow("ReCap fields are invalid");
    expect(() => extractSiweDelegationMode(siwe)).toThrow("ReCap fields are invalid");
  });

  test("stripping or changing the signed mode while retaining the signature fails signature verification", async () => {
    const base = { att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } }, prf: [] };
    const { authorization } = await signCacaoWithRawRecap(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }));
    const bytes = toBytes(authorization);
    const originalRecap = `urn:recap:${b64u(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }))}`;
    const tamperedRecap = `urn:recap:${b64u(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "attenuable" }))}`;
    // Build a new CACAO with the same signature bytes but swapped resource.
    const sigOffset = bytes.length - 65 - 1 - 1 - 7; // grab signature directly via re-encoding with old sig
    expect(sigOffset).toBeGreaterThan(0);
    const siwe = makeSiwe(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }));
    const sig = await owner.signMessage({ message: siwe });
    const sigBytes = new Uint8Array(Buffer.from(sig.slice(2), "hex"));
    const payloadBase = {
      domain: "example.com",
      iss: fixture.ownerDid,
      aud: fixture.delegation.audience,
      version: 1,
      nonce: "abcd1234",
      iat: "2026-01-01T00:00:00.000Z",
      exp: "2026-02-01T00:00:00.000Z",
      statement: STATEMENT,
    };
    const flipped = toAuthorization(encodeDagCbor({
      h: { t: "eip4361" },
      p: { ...payloadBase, resources: [tamperedRecap] },
      s: { t: "eip191", s: sigBytes },
    }));
    const stripped = toAuthorization(encodeDagCbor({
      h: { t: "eip4361" },
      p: { ...payloadBase, resources: [`urn:recap:${b64u(JSON.stringify(base))}`] },
      s: { t: "eip191", s: sigBytes },
    }));
    expect(originalRecap).not.toBe(tamperedRecap);
    await expect(parseSignedSiweCacao(flipped)).rejects.toThrow("CACAO signature is invalid");
    await expect(parseSignedSiweCacao(stripped)).rejects.toThrow("CACAO signature is invalid");
  });

  test("withSiweDelegationMode emits canonical key order and preserves every non-ReCap byte", () => {
    const baseJson = JSON.stringify({ att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } }, prf: [] });
    const baseSiwe = makeSiwe(baseJson);

    const marked = withSiweDelegationMode(baseSiwe, "terminal");
    expect(extractSiweDelegationMode(marked)).toBe("terminal");

    const baseHead = baseSiwe.slice(0, baseSiwe.lastIndexOf("- urn:recap:"));
    const markedHead = marked.slice(0, marked.lastIndexOf("- urn:recap:"));
    expect(markedHead).toBe(baseHead);

    const recapToken = marked.slice(marked.lastIndexOf("urn:recap:") + "urn:recap:".length);
    expect(recapToken).not.toContain("=");
    expect(Buffer.from(recapToken, "base64url").toString("utf8")).toBe(
      JSON.stringify({ att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } }, prf: [], [DELEGATION_MODE_KEY]: "terminal" }),
    );
  });

  test("checkChangedExpiration preserves attenuable, accepts absent for attenuable, refuses flipped mode and dropped terminal", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const base = { att: { [RESOURCE]: { "tinycloud.kv/get": [{}] } }, prf: [] };
    const preparedAttenuable = makeSiwe(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "attenuable" }), {
      expirationTime: "2026-02-01T00:00:00.000Z",
    });
    const preparedTerminal = makeSiwe(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }), {
      expirationTime: "2026-02-01T00:00:00.000Z",
    });

    const signedAttenuable = makeSiwe(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "attenuable" }), {
      expirationTime: "2026-01-15T00:00:00.000Z",
    });
    const signedTerminal = makeSiwe(JSON.stringify({ ...base, [DELEGATION_MODE_KEY]: "terminal" }), {
      expirationTime: "2026-01-15T00:00:00.000Z",
    });
    const signedAbsent = makeSiwe(JSON.stringify(base), {
      expirationTime: "2026-01-15T00:00:00.000Z",
    });

    // Matching modes pass.
    expect(checkChangedExpiration({ preparedSiwe: preparedAttenuable, signedSiwe: signedAttenuable, now })).toBeNull();
    expect(checkChangedExpiration({ preparedSiwe: preparedTerminal, signedSiwe: signedTerminal, now })).toBeNull();
    // Absent stays accepted for attenuable (legacy-attenuable / pre-#735 OpenKey).
    expect(checkChangedExpiration({ preparedSiwe: preparedAttenuable, signedSiwe: signedAbsent, now })).toBeNull();
    // Flipped modes are refused in both directions.
    expect(checkChangedExpiration({ preparedSiwe: preparedAttenuable, signedSiwe: signedTerminal, now })).toContain(
      "delegation mode",
    );
    expect(checkChangedExpiration({ preparedSiwe: preparedTerminal, signedSiwe: signedAttenuable, now })).toContain(
      "delegation mode",
    );
    // Dropping a declared terminal mode to absent is refused (would escalate to legacy-attenuable).
    expect(checkChangedExpiration({ preparedSiwe: preparedTerminal, signedSiwe: signedAbsent, now })).toContain(
      "delegation mode",
    );
  });

  test("isTerminalParentRefusal recognizes node error code and Monica message matches verbatim", () => {
    expect(TERMINAL_REDELEGATION_REFUSED_MESSAGE).toBe(
      "This access was given only to you, so it can't be passed on. Ask the owner to give it directly to the app or agent that needs it.",
    );
    expect(isTerminalParentRefusal("401 - terminal-parent-cannot-redelegate")).toBe(true);
    expect(isTerminalParentRefusal({ code: "TERMINAL_PARENT_CANNOT_REDELEGATE" })).toBe(true);
    expect(isTerminalParentRefusal(Object.assign(new Error("outer"), { cause: { error: "terminal-parent-cannot-redelegate" } }))).toBe(true);
    expect(isTerminalParentRefusal(new Error("something else"))).toBe(false);
  });
});
