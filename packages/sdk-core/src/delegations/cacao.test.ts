import { describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import fixture from "../../test-fixtures/siwe-cacao/owner-share.json";

// Real CACAOs from the node SDK (wasm completeSessionSetup and
// TinyCloudNode.signOwnerRevocation), signed with a public test key.
const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const toBytes = (authorization: string) => new Uint8Array(Buffer.from(authorization, "base64url"));
const toAuthorization = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const concat = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));
type Payload = Record<string, unknown>;

/** The signed payload of a fixture CACAO. */
function fixturePayload(authorization: string): Payload {
  const decoded = cborToJson(toBytes(authorization));
  if (typeof decoded !== "object" || decoded === null || !("p" in decoded) || typeof decoded.p !== "object" || decoded.p === null) throw new Error("fixture is not a CACAO");
  return { ...decoded.p };
}

/** Minimal test-only CBOR reader for the fixtures (text, ints, arrays, maps; bytes as hex). */
function cborToJson(bytes: Uint8Array): unknown {
  let offset = 0;
  const read = (): unknown => {
    const initial = bytes[offset++]!;
    const major = initial >> 5;
    let length = initial & 0x1f;
    if (length === 24) length = bytes[offset++]!;
    else if (length === 25) { length = (bytes[offset]! << 8) | bytes[offset + 1]!; offset += 2; }
    if (major === 0) return length;
    if (major === 2) return { bytes: Buffer.from(bytes.subarray(offset, offset += length)).toString("hex") };
    if (major === 3) return new TextDecoder().decode(bytes.subarray(offset, offset += length));
    if (major === 4) return Array.from({ length }, read);
    if (major === 5) return Object.fromEntries(Array.from({ length }, () => [read() as string, read()]));
    throw new Error("unexpected fixture CBOR");
  };
  return read();
}

/** Sign `payload` as the test owner the way a wallet signs a CACAO, with no validation of the payload. */
async function signCacao(payload: Payload): Promise<string> {
  const pkh = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(payload.iss))!;
  const message = new SiweMessage({
    domain: String(payload.domain), address: pkh[2]!, uri: String(payload.aud), version: "1",
    chainId: Number(pkh[1]), nonce: String(payload.nonce), issuedAt: String(payload.iat),
    ...(typeof payload.statement === "string" && payload.statement !== "" ? { statement: payload.statement } : {}),
    ...(typeof payload.exp === "string" && payload.exp !== "" ? { expirationTime: payload.exp } : {}),
    ...(typeof payload.nbf === "string" && payload.nbf !== "" ? { notBefore: payload.nbf } : {}),
    ...(Array.isArray(payload.resources) && payload.resources.length > 0 ? { resources: payload.resources as string[] } : {}),
  }).prepareMessage();
  const signature = await owner.signMessage({ message });
  return toAuthorization(encodeDagCbor({ h: { t: "eip4361" }, p: payload, s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) } }));
}

describe("parseSignedSiweCacao", () => {
  test("verifies a real owner delegation CACAO and returns what it signs", async () => {
    const parsed = await parseSignedSiweCacao(fixture.delegation.authorization, fixture.delegation.cid);

    expect(parsed).toMatchObject({ cid: fixture.delegation.cid, issuer: fixture.ownerDid, audience: fixture.delegation.audience, expiresAt: expect.any(String) });
    expect(Object.keys(parsed.attenuation)).toEqual([fixture.delegation.resource]);
    expect(parsed.attenuation[fixture.delegation.resource]).toEqual({ "tinycloud.kv/get": [{}] });
    expect(Object.getPrototypeOf(parsed.attenuation)).toBeNull();
  });

  test("verifies a real owner revocation from TinyCloudNode.signOwnerRevocation", async () => {
    const parsed = await parseSignedSiweCacao(fixture.revocation.authorization);

    expect(parsed).toMatchObject({ issuer: fixture.ownerDid, audience: fixture.revocation.audience });
    expect(Object.keys(parsed.attenuation)).toEqual([]);
  });

  test("re-signing the same payload in canonical form is accepted (control for the variants below)", async () => {
    const authorization = await signCacao(fixturePayload(fixture.delegation.authorization));
    await expect(parseSignedSiweCacao(authorization)).resolves.toMatchObject({ issuer: fixture.ownerDid });
  });

  test("rejects bytes that do not hash to the expected CID", async () => {
    await expect(parseSignedSiweCacao(fixture.delegation.authorization, fixture.revocation.audience.slice("ucan:".length).replace(/.$/, "a")))
      .rejects.toThrow("CID does not match");
  });

  // Variants that keep the signed SIWE message, and so the signature, while changing the bytes and CID.
  test("rejects a non-minimal integer encoding of the same version", async () => {
    const bytes = toBytes(fixture.delegation.authorization);
    const key = encodeDagCbor("version");
    const at = Buffer.from(bytes).indexOf(Buffer.from(key)) + key.length;
    expect(bytes[at]).toBe(0x01);
    const variant = concat(bytes.subarray(0, at), [0x18, 0x01], bytes.subarray(at + 1));
    await expect(parseSignedSiweCacao(toAuthorization(variant))).rejects.toThrow("not canonical DAG-CBOR");
  });

  test("rejects the version as the string \"1\"", async () => {
    const payload = { ...fixturePayload(fixture.delegation.authorization), version: "1" };
    await expect(parseSignedSiweCacao(await signCacao(payload))).rejects.toThrow("version must be the integer 1");
  });

  test.each([
    ["an empty resources list", { resources: [] }, "non-empty array"],
    ["an empty Not Before", { nbf: "" }, "nbf must be a non-empty string"],
    ["an unsigned extra field", { extra: "x" }, "unknown field \"extra\""],
  ])("rejects %s", async (_case, change, message) => {
    const payload = { ...fixturePayload(fixture.revocation.authorization), ...change };
    await expect(parseSignedSiweCacao(await signCacao(payload))).rejects.toThrow(message);
  });

  test("rejects a duplicate map key", async () => {
    const bytes = toBytes(fixture.revocation.authorization);
    expect(bytes[0]).toBe(0xa3);
    const variant = concat([0xa4], bytes.subarray(1), encodeDagCbor("h"), encodeDagCbor({ t: "eip4361" }));
    await expect(parseSignedSiweCacao(toAuthorization(variant))).rejects.toThrow("duplicate key \"h\"");
  });

  test("rejects a __proto__ map key", async () => {
    const bytes = toBytes(fixture.revocation.authorization);
    const variant = concat([0xa4], bytes.subarray(1), encodeDagCbor("__proto__"), [0xa0]);
    await expect(parseSignedSiweCacao(toAuthorization(variant))).rejects.toThrow("__proto__");
  });

  test("rejects trailing bytes", async () => {
    const variant = concat(toBytes(fixture.revocation.authorization), [0x00]);
    await expect(parseSignedSiweCacao(toAuthorization(variant))).rejects.toThrow("trailing bytes");
  });

  test("rejects nesting deeper than 64 levels", async () => {
    const variant = concat(new Array(100).fill(0x81), [0x00]);
    await expect(parseSignedSiweCacao(toAuthorization(variant))).rejects.toThrow("nesting exceeds 64 levels");
  });

  test("rejects input over 64 KiB before decoding it", async () => {
    await expect(parseSignedSiweCacao(toAuthorization(new Uint8Array(64 * 1024 + 1)))).rejects.toThrow("exceeds 65536 bytes");
  });

  test("rejects an altered signature", async () => {
    const bytes = toBytes(fixture.delegation.authorization);
    // The CACAO ends with the signature bytes, then `"t": "eip191"` (9 bytes).
    bytes[bytes.length - 12]! ^= 0x01;
    await expect(parseSignedSiweCacao(toAuthorization(bytes))).rejects.toThrow("signature is invalid");
  });

  test("rejects an issuer chain ID that rounds to the signed one", async () => {
    const payload = fixturePayload(fixture.revocation.authorization);
    // A wallet signs chain 9007199254740992; the issuer claims ...993, which Number() rounds to ...992.
    const iss = String(payload.iss).replace(":1:", ":9007199254740993:");
    await expect(parseSignedSiweCacao(await signCacao({ ...payload, iss }))).rejects.toThrow("safe-integer chain ID");
  });

  test.each([
    ["a string", "not-an-array"],
    ["an empty list", []],
    ["a list of non-objects", ["x"]],
  ])("rejects a signed ReCap whose caveats are %s", async (_case, caveats) => {
    const resource = `urn:recap:${Buffer.from(JSON.stringify({ att: { [fixture.delegation.resource]: { "tinycloud.kv/get": caveats } }, prf: [] })).toString("base64url")}`;
    const payload = { ...fixturePayload(fixture.revocation.authorization), statement: "anything", resources: [resource] };
    await expect(parseSignedSiweCacao(await signCacao(payload))).rejects.toThrow("caveats must be a non-empty array of objects");
  });

  test("rejects a validly signed statement that does not describe its ReCap", async () => {
    const payload = fixturePayload(fixture.delegation.authorization);
    const statement = String(payload.statement).replace("'get'", "'put'");
    expect(statement).not.toBe(payload.statement);
    await expect(parseSignedSiweCacao(await signCacao({ ...payload, statement }))).rejects.toThrow("statement does not match its ReCap");
  });
});
