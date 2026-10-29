import { afterEach, beforeEach, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { BOOTSTRAP_SESSION_REQUESTS, extractRecapAttenuations, type SiweConfig } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const metadata = ["urn:tinycloud:recipients:eyJ2IjoxfQ"];
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return Response.json({ activated: ["space"], skipped: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(siweConfig?: SiweConfig, preparedSiwe?: (siwe: string) => string) {
  const wasm = new NodeWasmBindings();
  const originals: string[] = [];
  const completed: string[] = [];
  const signed: string[] = [];
  const prepare = wasm.prepareSession.bind(wasm);
  wasm.prepareSession = (params) => {
    const result = prepare(params);
    if (preparedSiwe) result.siwe = preparedSiwe(result.siwe);
    originals.push(result.siwe);
    return result;
  };
  const complete = wasm.completeSessionSetup.bind(wasm);
  wasm.completeSessionSetup = (params) => {
    completed.push(params.siwe);
    return complete(params);
  };
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const sign = signer.signMessage.bind(signer);
  signer.signMessage = async (message) => { signed.push(message); return sign(message); };
  const storage = new MemorySessionStorage();
  const auth = new NodeUserAuthorization({
    signer, wasmBindings: wasm, siweConfig,
    domain: "example.com", tinycloudHosts: ["https://tinycloud.test"],
    signStrategy: { type: "auto-sign" }, sessionStorage: storage,
    enablePublicSpace: false, includeAccountRegistryPermissions: false,
  });
  return { auth, storage, originals, completed, signed };
}

function checkInsertion(original: string, actual: string) {
  const recapLine = original.split("\n").find((line) => line.startsWith("- urn:recap:"))!;
  expect(actual).toBe(original.replace(recapLine, [...metadata.map((uri) => `- ${uri}`), recapLine].join("\n")));
  expect(new SiweMessage(actual).resources).toEqual([...metadata, recapLine.slice(2)]);
}

test("sign-in signs and retains the exact metadata-bearing WASM message", async () => {
  const f = fixture({ resources: metadata, statement: "Not a statement override" });
  const session = await f.auth.signIn();
  checkInsertion(f.originals[0], session.siwe!);
  expect(f.signed).toEqual([session.siwe!]);
  expect(f.completed).toEqual([session.siwe!]);
  expect(session.siwe).not.toContain("Not a statement override");
  expect((await f.storage.load(session.address))?.siwe).toBe(session.siwe);
});

test("external and versioned preparations include metadata before completion", async () => {
  for (const versioned of [false, true]) {
    const f = fixture({ resources: metadata });
    const p = versioned ? await f.auth.prepareOpenKeySignIn() : await f.auth.prepareSessionForSigning();
    checkInsertion(f.originals[0], p.prepared.siwe);
    if ("request" in p) expect(p.request.siwe).toBe(p.prepared.siwe);
    const signer = new PrivateKeySigner("1".padStart(64, "0"));
    const session = await f.auth.signInWithPreparedSession(p.prepared, await signer.signMessage(p.prepared.siwe), p.keyId, p.jwk);
    expect(session.siwe).toBe(p.prepared.siwe);
    expect(f.completed).toEqual([p.prepared.siwe]);
    expect((await f.storage.load(session.address))?.siwe).toBe(p.prepared.siwe);
  }
});

test("bootstrap preparations sign and retain metadata without changing the ReCap", async () => {
  const f = fixture({ resources: metadata });
  await f.auth.signIn();
  const session = await f.auth.createBootstrapSession({
    spaceId: "tinycloud:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:default",
    capabilityRequest: BOOTSTRAP_SESSION_REQUESTS.account,
  });
  checkInsertion(f.originals[1], session.siwe!);
  expect(f.signed[1]).toBe(session.siwe!);
  expect(f.completed[1]).toBe(session.siwe!);
});

test("absent and empty resource options leave every prepared byte unchanged", async () => {
  for (const config of [undefined, { resources: [] }]) {
    const f = fixture(config);
    const session = await f.auth.signIn();
    expect(session.siwe).toBe(f.originals[0]);
  }
});

for (const resource of [
  "https://example.com/\nURI: https://other.example", "urn:test:\rNonce: changed",
  "urn:test:\n\nA different statement\n\nURI: did:key:other",
  "urn:test:\0", "urn:test:\t", "urn:test:\u007f", "urn:test:\u0085",
  "not a URI", "/relative", "https://", "urn:recap:replacement", "URN:RECAP:duplicate",
  ...["\n", "\r", "\u2028", "\u2029"].map(end => `${metadata[0]}${end}`),
]) {
  test(`invalid metadata ${JSON.stringify(resource)} fails before signing`, async () => {
    const f = fixture({ resources: [resource] });
    await expect(f.auth.signIn()).rejects.toThrow();
    await expect(f.auth.prepareSessionForSigning()).rejects.toThrow();
    await expect(f.auth.prepareOpenKeySignIn()).rejects.toThrow();
    expect(f.signed).toEqual([]);
    expect(f.completed).toEqual([]);
    expect(f.originals).toEqual([]);
  });
}

test("caller ReCaps cannot duplicate, replace, remove grants or change caveats", async () => {
  const source = await fixture().auth.prepareSessionForSigning();
  const recap = new SiweMessage(source.prepared.siwe).resources!.at(-1)!;
  const decoded = JSON.parse(Buffer.from(recap.slice("urn:recap:".length), "base64url").toString());
  const resource = Object.keys(decoded.att)[0];
  const ability = Object.keys(decoded.att[resource])[0];
  const removed = structuredClone(decoded);
  delete removed.att[resource][ability];
  const changed = structuredClone(decoded);
  changed.att[resource][ability] = [{ limit: 1 }];
  for (const supplied of [recap, ...[removed, changed].map((value) =>
    `urn:recap:${Buffer.from(JSON.stringify(value)).toString("base64url")}`)]) {
    const f = fixture({ resources: [supplied] });
    await expect(f.auth.signIn()).rejects.toThrow();
    expect(f.signed).toEqual([]);
  }
});

test("insertion preserves original metadata, statement, caveats and proofs byte-for-byte", async () => {
  const f = fixture({ resources: metadata }, (siwe) => {
    const recap = new SiweMessage(siwe).resources!.at(-1)!;
    const value = JSON.parse(Buffer.from(recap.slice("urn:recap:".length), "base64url").toString());
    for (const actions of Object.values(value.att) as Record<string, unknown>[]) {
      for (const action of Object.keys(actions)) actions[action] = [{ limit: 1 }];
    }
    value.prf = ["bafy-proof"];
    return siwe.replace(recap, `urn:recap:${Buffer.from(JSON.stringify(value)).toString("base64url")}`)
      .replace("Resources:\n", "Resources:\n- urn:existing:metadata\n");
  });
  const p = await f.auth.prepareSessionForSigning();
  const original = f.originals[0];
  const recapLine = original.split("\n").find((line) => line.startsWith("- urn:recap:"))!;
  expect(p.prepared.siwe).toBe(original.replace(recapLine, [...metadata.map((uri) => `- ${uri}`), recapLine].join("\n")));
  expect(new SiweMessage(p.prepared.siwe).resources).toEqual(["urn:existing:metadata", ...metadata, recapLine.slice(2)]);
});

const phantomRecap = `urn:recap:${Buffer.from(JSON.stringify({
  att: { "tinycloud:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:default/kv/unrequested": {
    "tinycloud.kv/put": [{}],
  } },
})).toString("base64url")}`;

for (const path of ["ordinary", "external", "versioned", "bootstrap"] as const) {
  test(`${path} refuses embedded, encoded and escaped ReCaps before approval`, async () => {
    for (const resource of [
      `https://metadata.example/#${phantomRecap}`,
      `https://metadata.example/#${phantomRecap.replace("urn:recap:", "URN:RECAP:")}`,
      `https://metadata.example/#${encodeURIComponent(phantomRecap)}`,
      `https://metadata.example/#${encodeURIComponent(encodeURIComponent(phantomRecap))}`,
      `https://metadata.example/#%75%72%6e%3a%72%65%63%61%70%3a${phantomRecap.slice(10)}`,
      `https://metadata.example/#%5Cu0075rn%3Arecap%3A${phantomRecap.slice(10)}`,
    ]) {
      const resources = [...metadata];
      const f = fixture({ resources });
      if (path === "bootstrap") await f.auth.signIn();
      f.signed.length = 0; f.completed.length = 0;
      resources.splice(0, resources.length, resource);
      const pending = path === "ordinary" ? f.auth.signIn()
        : path === "external" ? f.auth.prepareSessionForSigning()
        : path === "versioned" ? f.auth.prepareOpenKeySignIn()
        : f.auth.createBootstrapSession({
          spaceId: "tinycloud:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:account",
          capabilityRequest: BOOTSTRAP_SESSION_REQUESTS.account,
        });
      await expect(pending).rejects.toThrow();
      expect(f.signed).toEqual([]);
      expect(f.completed).toEqual([]);
    }
  });
}

test("SDK and WASM extract only actual ReCap resource values", async () => {
  const { prepared } = await fixture().auth.prepareSessionForSigning();
  const original = prepared.siwe;
  const actual = original.replace("Resources:\n", `Resources:\n- https://metadata.example/#${phantomRecap}\n`);
  const wasm = new NodeWasmBindings();
  expect(wasm.parseRecapFromSiwe(actual)).toEqual(wasm.parseRecapFromSiwe(original));
  expect(extractRecapAttenuations(actual)).toEqual(extractRecapAttenuations(original));
});
