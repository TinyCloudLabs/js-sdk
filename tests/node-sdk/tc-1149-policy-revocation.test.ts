import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, TinyCloudNode } from "@tinycloud/node-sdk";
import { Wallet } from "ethers";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  contentSourceDigestHex,
  createCompactPolicyDescendant,
  createCompactPolicyInvocation,
  jcsCanonicalize,
  mintPolicySessionV3,
  policyCidFromCanonicalBytes,
  policyDigestHex,
  policyIdForDigestHex,
  registerPolicyV3,
  requestPolicyChallengeV3,
  signCompactUcanAuthorization,
  signCompactUcanRootAuthorization,
  unifiedNativeProjectionHashHex,
  type CompactUcanAuthorizationV1,
  type PolicySessionUcanV1,
  type UnifiedPolicyCapability,
} from "@tinycloud/sdk-core/policy";
import { SERVER_URL } from "./setup";

// These are fresh, disposable identities and real HTTP requests. No credential,
// authorization response or node decision is substituted by a local mock.
const origin = SERVER_URL;
const encoder = new TextEncoder();
const key = () => crypto.getRandomValues(new Uint8Array(32));
const did = (secret: Uint8Array) => `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(secret)]))}`;
const seconds = () => Math.floor(Date.now() / 1000);
const date = (time: number) => new Date(time * 1000).toISOString().replace(/\.000Z$/, "Z");
const signature = (secret: Uint8Array, domain: string, unsigned: unknown) => Buffer.from(ed25519.sign(sha256(encoder.encode(`${domain}\0${jcsCanonicalize(unsigned)}`)), secret)).toString("base64url");
const signer = (secret: Uint8Array) => async (bytes: Uint8Array) => ed25519.sign(bytes, secret);
const nonce = () => crypto.randomUUID();
const statusDenied = (status: number) => expect([401, 403]).toContain(status);

async function post(path: string, authorization: string, body?: string) {
  return fetch(new URL(path, origin), { method: "POST", headers: { Authorization: authorization, ...(body === undefined ? {} : { "content-type": "text/plain" }) }, body });
}

async function importDelegation(delegation: CompactUcanAuthorizationV1) {
  const response = await post("/delegate", delegation.authorization);
  if (response.status !== 200) throw new Error(`delegation import returned ${response.status}: ${await response.text()}`);
  const result = await response.json() as { cid: string };
  expect(result.cid).toBe(delegation.cid);
}

async function invoke(parent: { authorization: string; cid: string }, secret: Uint8Array, recipientDid: string, nodeDid: string, resource: string, action: "tinycloud.kv/get" | "tinycloud.kv/put", body?: string) {
  const invocation = createCompactPolicyInvocation({
    sessionAuthorization: parent.authorization, sessionCid: parent.cid,
    recipientDid, audienceDid: nodeDid, resource, action,
    caveat: { type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource }, privateKey: secret,
  });
  return post("/invoke", invocation.authorization, body);
}

async function signedReadTicket(f: { session: PolicySessionUcanV1; recipientKey: Uint8Array; recipientDid: string; nodeDid: string; resource: string }) {
  const invocation = createCompactPolicyInvocation({
    sessionAuthorization: f.session.authorization, sessionCid: f.session.cid,
    recipientDid: f.recipientDid, audienceDid: f.nodeDid, resource: f.resource, action: "tinycloud.kv/get",
    caveat: { type: "xyz.tinycloud.resource/selector", kind: "exact", value: f.resource }, privateKey: f.recipientKey,
  });
  const [space, path] = f.resource.split("/kv/");
  const response = await fetch(new URL("/signed/kv", origin), { method: "POST",
    headers: { Authorization: invocation.authorization, "content-type": "application/json" },
    body: JSON.stringify({ space, path, ttlSeconds: 40 }) });
  expect(response.status).toBe(200);
  const ticket = await response.json() as { url: string; ticketId: string; expiresAt: string };
  expect(ticket.ticketId).toBeTruthy();
  expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now() + 10_000);
  return ticket;
}


async function fixture(grantLifetime = 300, grantKind: "ucan" | "siwe" | "owner-signin" = "ucan",
  sharedRecipientKey?: Uint8Array, rootLifetime = 240, multiSpace = false) {
  const info = await fetch(new URL("/info", origin));
  expect(info.status).toBe(200);
  const { nodeId: nodeDid } = await info.json() as { nodeId: string };
  const ownerKey = key(), recipientKey = sharedRecipientKey ?? key(), childKey = key(), enforcerKey = key();
  let registrarKey = key();
  const wallet = grantKind === "ucan" ? undefined : Wallet.createRandom();
  const ownerDid = wallet ? `did:pkh:eip155:1:${wallet.address}` : did(ownerKey);
  let registrarDid = did(registrarKey);
  const recipientDid = did(recipientKey), childDid = did(childKey), enforcerDid = did(enforcerKey);
  const now = seconds(), expires = now + rootLifetime;
  const space = `tinycloud:${ownerDid.slice(4)}:applications`;
  const resource = `${space}/kv/tc-1149/${nonce()}`;
  const secondSpace = multiSpace ? `tinycloud:${ownerDid.slice(4)}:private` : undefined;
  const secondResource = secondSpace ? `${secondSpace}/kv/tc-1149/${nonce()}` : undefined;
  const encryptionNetwork = `urn:tinycloud:encryption:${ownerDid}:test`;
  const capability = { kind: "kv", resource, selector: "exact", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] } as const;
  const secondCapability = secondResource ? { kind: "kv", resource: secondResource, selector: "exact", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] } as const : undefined;
  const encryption = { kind: "encryption", resource: encryptionNetwork, action: "tinycloud.encryption/decrypt" } as const;
  const capabilities: UnifiedPolicyCapability[] = [capability, ...(secondCapability ? [secondCapability] : []), encryption];
  const selector = { type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource };
  const secondSelector = secondResource ? { type: "xyz.tinycloud.resource/selector", kind: "exact", value: secondResource } : undefined;
  const attenuation = { [resource]: { "tinycloud.kv/get": [selector], "tinycloud.kv/put": [selector] },
    ...(secondResource && secondSelector ? { [secondResource]: { "tinycloud.kv/get": [secondSelector], "tinycloud.kv/put": [secondSelector] } } : {}),
    [encryptionNetwork]: { "tinycloud.encryption/decrypt": [{}] } };
  let ownerNode: TinyCloudNode | undefined;
  let grant: { cid: string; authorization: string };
  let grantExpiresAt = now + grantLifetime;
  if (wallet) {
    ownerNode = new TinyCloudNode({ host: origin, privateKey: wallet.privateKey,
      autoBootstrapAccount: false, autoCreateSpace: true, includeAccountRegistryPermissions: false,
      ...(grantKind === "owner-signin" ? { sessionExpirationMs: grantLifetime * 1000 } : {}),
      manifest: { app_id: "tc-1149-policy-tests", name: "Policy revocation test", defaults: false,
        includePublicSpace: false, prefix: "", space: "applications",
        permissions: [{ service: "tinycloud.kv", space: "applications", path: "tc-1149/",
          actions: ["get", "put"] }, { service: "tinycloud.encryption", space: "applications",
          path: encryptionNetwork, actions: ["decrypt"] }] } });
    await ownerNode.signIn();
    expect(await ownerNode.hostOwnedSpace("applications")).toBe(space);
    const session = ownerNode.session;
    if (!session) throw new Error("SIWE owner sign-in did not establish a signed session");
    if (grantKind === "owner-signin") {
      const secret = session.jwk.d;
      if (typeof secret !== "string") throw new Error("SDK sign-in session has no Ed25519 signing key");
      registrarKey = Buffer.from(secret, "base64url");
      registrarDid = session.verificationMethod.split("#", 1)[0]!;
      expect(did(registrarKey)).toBe(registrarDid);
      const expiration = session.siwe.match(/^Expiration Time: (.+)$/m)?.[1];
      grantExpiresAt = Math.floor(Date.parse(expiration ?? "") / 1000);
      if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= seconds()) throw new Error("SIWE sign-in expiry is invalid");
      grant = { cid: session.delegationCid, authorization: session.delegationHeader.Authorization };
    } else {
      const wasm = new NodeWasmBindings();
      const prepared = wasm.prepareSession({ abilities: { kv: { [resource.slice(`${space}/kv/`.length)]: ["tinycloud.kv/get", "tinycloud.kv/put"] } },
        rawAbilities: { [encryptionNetwork]: ["tinycloud.encryption/decrypt"] },
        address: wallet.address, chainId: 1, domain: new URL(origin).hostname,
        issuedAt: new Date().toISOString(), expirationTime: new Date(grantExpiresAt * 1000).toISOString(),
        spaceId: space, delegateUri: registrarDid, parents: [session.delegationCid] });
      const signed = wasm.completeSessionSetup({ ...prepared, signature: await wallet.signMessage(prepared.siwe) });
      const response = await fetch(new URL("/delegate", origin), { method: "POST", headers: signed.delegationHeader });
      expect(response.status).toBe(200);
      expect((await response.json() as { cid: string }).cid).toBe(signed.delegationCid);
      grant = { cid: signed.delegationCid, authorization: signed.delegationHeader.Authorization };
    }
  } else {
    // Host each space as its real owner, independently of the registrar grant.
    const host = await signCompactUcanRootAuthorization({ issuerDid: ownerDid, audienceDid: ownerDid,
      attenuation: { [`${space}/space`]: { "tinycloud.space/host": [{}] }, [resource]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
        ...(secondSpace && secondResource ? { [`${secondSpace}/space`]: { "tinycloud.space/host": [{}] },
          [secondResource]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } : {}) },
      facts: [{}], notBefore: now - 2, expiresAt: expires, nonce: nonce(), sign: signer(ownerKey) });
    await importDelegation(host);
    // Distinct owner -> third-party registrar grant, not an owner-session assertion.
    const ucan = await signCompactUcanRootAuthorization({ issuerDid: ownerDid, audienceDid: registrarDid,
      attenuation, facts: [{}], notBefore: now - 2, expiresAt: grantExpiresAt,
      nonce: nonce(), sign: signer(ownerKey) });
    await importDelegation(ucan);
    grant = ucan;
  }
  // Real registrar-signed, imported recipient authorization used as v1
  // credential evidence; the holder signs its own challenge-bound presentation.
  const credentialAttenuation = wallet ? { [resource]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } :
    { [resource]: attenuation[resource], ...(secondResource ? { [secondResource]: attenuation[secondResource] } : {}) };
  const credential = await signCompactUcanAuthorization({ issuerDid: registrarDid, audienceDid: recipientDid,
    attenuation: credentialAttenuation, facts: [{}], proofs: [grant.cid],
    notBefore: now, expiresAt: Math.min(now + 50, grantExpiresAt - 1), nonce: nonce(), sign: signer(registrarKey) });
  await importDelegation(credential);
  const makeRegistration = async () => {
    const source = { shareId: nonce(), kvResource: resource, selector: "exact", encryptionNetwork,
      encryptedSymmetricKeyDigestHex: "aa".repeat(32), keyVersion: 1, mode: "mutable" } as const;
    const unsigned = { schema: "xyz.tinycloud.policy/policy/v1", ownerDid: registrarDid,
      createdAt: date(now - 2), expiresAt: date(expires), contentSource: source, capabilityCeiling: capabilities } as const;
    const policyDigest = policyDigestHex(unsigned);
    const policy = { ...unsigned, policyId: policyIdForDigestHex(policyDigest), signature: {
      suite: "Ed25519", signerDid: registrarDid, value: signature(registrarKey, unsigned.schema, unsigned),
    } };
    const policyCid = policyCidFromCanonicalBytes(encoder.encode(jcsCanonicalize(policy)));
    const orderedCeiling = [...capabilities].sort((a, b) => {
      const left = jcsCanonicalize(a), right = jcsCanonicalize(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const ceilingDigest = sha256(encoder.encode(`xyz.tinycloud.policy/PolicyCapability/v1\0${jcsCanonicalize(orderedCeiling)}`));
    const fact = { ownerDid: registrarDid, policyId: policy.policyId, policyDigestHex: policyDigest, policyCid,
      contentSourceDigestHex: contentSourceDigestHex(source),
      capabilityCeilingHashHex: Buffer.from(ceilingDigest).toString("hex"),
      nativeProjectionHashHex: unifiedNativeProjectionHashHex(capabilities), nodeAudience: nodeDid };
    const root = (role: "policy-authority" | "policy-enforcement") => signCompactUcanRootAuthorization({
      issuerDid: registrarDid, audienceDid: role === "policy-authority" ? `did:tinycloud:policy:${policyDigest}` : enforcerDid,
      attenuation, facts: [{ ...fact, role, mode: role === "policy-authority" ? "policy-source" : "conditional-mint", ...(role === "policy-enforcement" ? { enforcerDid } : {}) }],
      notBefore: now - 2, expiresAt: expires, nonce: nonce(), sign: signer(registrarKey),
    });
    const policyRoot = await root("policy-authority"), enforcementRoot = await root("policy-enforcement");
    const registration = { nodeOrigin: origin, policyCid, policy, policyRoot, enforcementRoot,
      contentSourceDigestHex: fact.contentSourceDigestHex, nativeProjectionHashHex: fact.nativeProjectionHashHex,
      rootExpiresAt: date(expires), enforcerDid, expectedNodeAudience: nodeDid };
    return { policyCid, policyRoot, enforcementRoot, registration };
  };
  const { policyCid, policyRoot, enforcementRoot, registration } = await makeRegistration();
  expect(await registerPolicyV3(registration)).toMatchObject({ policyCid, policyRootCid: policyRoot.cid });
  const mint = async (requestedCapabilities: UnifiedPolicyCapability[] =
    secondCapability ? [capability, secondCapability] : [capability]) => {
    const challenge = await requestPolicyChallengeV3({ nodeOrigin: origin, policyCid, recipientDid, requestedCapabilities });
    const issuedAt = date(seconds()), expiresAt = date(seconds() + 50);
    const common = { challengeId: challenge.challengeId, nonce: challenge.nonce, policyCid, requestedCapabilities, issuedAt, expiresAt };
    const claimUnsigned = { schema: "xyz.tinycloud.policy/claim/v2", jti: nonce(), ...common, issuerDid: registrarDid,
      subjectDid: recipientDid, holderDid: recipientDid, recipientDid,
      credentialEvidence: [{ format: "ucan/0.10.0", issuerDid: registrarDid, subjectDid: recipientDid,
        digestHex: Buffer.from(sha256(encoder.encode(credential.authorization))).toString("hex") }] };
    const presentationUnsigned = { schema: "xyz.tinycloud.policy/presentation/v2", jti: nonce(), ...common,
      holderDid: recipientDid, subjectDid: recipientDid, vpBytesBase64: Buffer.from(credential.authorization).toString("base64url") };
    return mintPolicySessionV3({ nodeOrigin: origin, policyCid, policyRootCid: policyRoot.cid, enforcementRootCid: enforcementRoot.cid,
      recipientDid, requestedCapabilities, challenge,
      claim: { ...claimUnsigned, signature: { suite: "Ed25519", signerDid: registrarDid, value: signature(registrarKey, "xyz.tinycloud.policy/Claim/v2", claimUnsigned) } },
      presentation: { ...presentationUnsigned, signature: { suite: "Ed25519", signerDid: recipientDid, value: signature(recipientKey, "xyz.tinycloud.policy/Presentation/v2", presentationUnsigned) } },
    });
  };
  const session = await mint();
  const descendant = createCompactPolicyDescendant({ parentAuthorization: session.authorization, parentCid: session.cid,
    issuerDid: recipientDid, audienceDid: childDid, attenuation: { [resource]: attenuation[resource] }, privateKey: recipientKey });
  // The live Node validates descendant nbf against its own clock; fake Bun timers cannot advance the server.
  await Bun.sleep(Math.max(0, descendant.payload.nbf * 1000 - Date.now() + 100));
  await importDelegation(descendant);
  return { ownerKey, ownerNode, registrarKey, recipientKey, childKey, ownerDid, registrarDid, recipientDid, childDid, nodeDid,
    resource, secondResource, secondSpace, capability, secondCapability, attenuation, ordinaryAttenuation: credentialAttenuation,
    grant, grantExpiresAt, rootExpiresAt: expires, policyRoot, enforcementRoot, session, descendant, registration, mint,
    newRegistration: async () => (await makeRegistration()).registration };
}

// A descendant invocation has its own signer and proof edge; it is not a bearer replay of S0.
async function descendantInvoke(f: { childDid: string; nodeDid: string; resource: string; childKey: Uint8Array; descendant: CompactUcanAuthorizationV1; registration: { policyCid: string }; session: PolicySessionUcanV1 }, action: "tinycloud.kv/get" | "tinycloud.kv/put", body?: string) {
  const now = seconds();
  const invocation = await signCompactUcanAuthorization({ issuerDid: f.childDid, audienceDid: f.nodeDid,
    attenuation: { [f.resource]: { [action]: [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: f.resource }] } },
    facts: [{ type: "tinycloud.policy.invocation/v1", policyCid: f.registration.policyCid, sessionCid: f.session.cid }],
    proofs: [f.descendant.cid], notBefore: now, expiresAt: Math.min(now + 40, f.descendant.payload.exp), nonce: nonce(), sign: signer(f.childKey) });
  return post("/invoke", invocation.authorization, body);
}

async function ordinaryInvoke(f: { recipientDid: string; nodeDid: string; resource: string; recipientKey: Uint8Array; ordinaryAttenuation: Record<string, Record<string, unknown[]>> }, child: CompactUcanAuthorizationV1, action: "tinycloud.kv/get" | "tinycloud.kv/put", body?: string) {
  const now = seconds();
  const invocation = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: f.nodeDid,
    attenuation: { [f.resource]: { [action]: f.ordinaryAttenuation[f.resource]![action] } },
    facts: [{}], proofs: [child.cid], notBefore: now, expiresAt: Math.min(now + 35, child.payload.exp),
    nonce: nonce(), sign: signer(f.recipientKey) });
  return post("/invoke", invocation.authorization, body);
}

async function ordinaryGrandchildInvoke(f: { childDid: string; nodeDid: string; resource: string; childKey: Uint8Array }, child: CompactUcanAuthorizationV1, action: "tinycloud.kv/get" | "tinycloud.kv/put", body?: string) {
  const now = seconds();
  const invocation = await signCompactUcanAuthorization({ issuerDid: f.childDid, audienceDid: f.nodeDid,
    attenuation: { [f.resource]: { [action]: [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: f.resource }] } },
    facts: [{}], proofs: [child.cid], notBefore: now, expiresAt: Math.min(now + 30, child.payload.exp),
    nonce: nonce(), sign: signer(f.childKey) });
  return post("/invoke", invocation.authorization, body);
}

async function ordinaryChild(f: { registrarDid: string; recipientDid: string; resource: string; registrarKey: Uint8Array; ordinaryAttenuation: Record<string, Record<string, unknown[]>>; grant: { cid: string } }) {
  const now = seconds();
  const child = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.recipientDid,
    attenuation: { [f.resource]: f.ordinaryAttenuation[f.resource] }, facts: [{}], proofs: [f.grant.cid],
    notBefore: now, expiresAt: now + 45, nonce: nonce(), sign: signer(f.registrarKey) });
  await importDelegation(child);
  return child;
}

async function ownerGet(f: { ownerDid: string; nodeDid: string; resource: string; ownerKey: Uint8Array }) {
  const now = seconds();
  const invocation = await signCompactUcanAuthorization({ issuerDid: f.ownerDid, audienceDid: f.nodeDid,
    attenuation: { [f.resource]: { "tinycloud.kv/get": [{}] } }, facts: [{}], proofs: [],
    notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.ownerKey) });
  return post("/invoke", invocation.authorization);
}

async function ownerRead(f: { ownerDid: string; nodeDid: string; resource: string; ownerKey: Uint8Array }) {
  const response = await ownerGet(f);
  expect(response.status).toBe(200);
  return response.text();
}

async function siweOwnerRead(f: { ownerNode?: TinyCloudNode; resource: string }) {
  if (!f.ownerNode) throw new Error("SIWE owner session is required");
  const path = f.resource.split("/kv/", 2)[1];
  if (!path) throw new Error("policy content resource has no KV path");
  const result = await f.ownerNode.space("applications").kv.get<string>(path, { raw: true });
  if (!result.ok) throw new Error(`owner read failed: ${result.error.code}: ${result.error.message}`);
  return result.data.data;
}

type KeyRevokeScope = { kind: "global" } | { kind: "space"; spaceId: string };
type KeyRevocationBody = { targetDid: string; scope: KeyRevokeScope; authorization: string };

async function signedKeyRevocation(targetDid: string, privateKey: Uint8Array, nodeDid: string,
  scope: KeyRevokeScope = { kind: "global" }, requestNonce = nonce(), proofs: string[] = [], lifetime = 40) {
  const now = seconds();
  const authorization = await signCompactUcanAuthorization({ issuerDid: did(privateKey), audienceDid: nodeDid,
    attenuation: { [`urn:tinycloud:key:${targetDid}`]: { "tinycloud.key/revoke": [{ version: 1, targetDid, scope }] } },
    facts: [{}], proofs, notBefore: now, expiresAt: now + lifetime, nonce: requestNonce, sign: signer(privateKey) });
  return { targetDid, scope, authorization: authorization.authorization };
}

async function postKeyRevocation(body: KeyRevocationBody) {
  return fetch(new URL("/keys/revoke", origin), { method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body) });
}

async function keyRevocationRequest(targetDid: string, privateKey: Uint8Array, nodeDid: string) {
  return postKeyRevocation(await signedKeyRevocation(targetDid, privateKey, nodeDid));
}

async function combinedSpaceRead(f: { session: PolicySessionUcanV1; recipientKey: Uint8Array; recipientDid: string;
  nodeDid: string; resource: string; secondResource: string }) {
  const now = seconds();
  const selector = (resource: string) => ({ type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource });
  const invocation = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: f.nodeDid,
    attenuation: { [f.resource]: { "tinycloud.kv/get": [selector(f.resource)] },
      [f.secondResource]: { "tinycloud.kv/get": [selector(f.secondResource)] } },
    facts: [{ type: "tinycloud.policy.invocation/v1", policyCid: f.session.fact.policyCid, sessionCid: f.session.cid }],
    proofs: [f.session.cid], notBefore: now, expiresAt: Math.min(now + 40, f.session.exp),
    nonce: nonce(), sign: signer(f.recipientKey) });
  return post("/invoke", invocation.authorization);
}

async function twoSpaceFixture() {
  const f = await fixture(300, "ucan", undefined, 240, true);
  if (!f.secondResource || !f.secondSpace || !f.secondCapability)
    throw new Error("two-space fixture did not create its second capability");
  expect(f.registration.policy.capabilityCeiling).toEqual([f.capability, f.secondCapability,
    { kind: "encryption", resource: `urn:tinycloud:encryption:${f.ownerDid}:test`, action: "tinycloud.encryption/decrypt" }]);
  expect(f.session.att[f.resource]).toBeDefined();
  expect(f.session.att[f.secondResource]).toBeDefined();
  const first = `first-${nonce()}`, second = `second-${nonce()}`;
  expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", first)).status).toBe(200);
  expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/put", second)).status).toBe(200);
  expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).text()).toBe(first);
  expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).text()).toBe(second);
  expect((await combinedSpaceRead(f)).status).toBe(200);
  return { ...f, first, second, secondSpace: f.secondSpace, secondResource: f.secondResource };
}

describe("TC-1149 signed KV tickets over real node HTTP", () => {
  test("recipient key revocation immediately denies an issued signed GET ticket without denying an independent ticket", async () => {
    const revoked = await fixture();
    const independent = await fixture();
    const content = `signed-revoked-${nonce()}`, independentContent = `signed-independent-${nonce()}`;
    expect((await invoke(revoked.session, revoked.recipientKey, revoked.recipientDid, revoked.nodeDid, revoked.resource, "tinycloud.kv/put", content)).status).toBe(200);
    expect((await invoke(independent.session, independent.recipientKey, independent.recipientDid, independent.nodeDid, independent.resource, "tinycloud.kv/put", independentContent)).status).toBe(200);
    const ticket = await signedReadTicket(revoked), independentTicket = await signedReadTicket(independent);
    const before = await fetch(new URL(ticket.url, origin));
    expect(before.status).toBe(200);
    expect(await before.text()).toBe(content);
    const independentBefore = await fetch(new URL(independentTicket.url, origin));
    expect(independentBefore.status).toBe(200);
    expect(await independentBefore.text()).toBe(independentContent);

    expect((await keyRevocationRequest(revoked.recipientDid, revoked.recipientKey, revoked.nodeDid)).status).toBe(200);
    expect((await fetch(new URL(ticket.url, origin))).status).toBe(403);
    const independentAfter = await fetch(new URL(independentTicket.url, origin));
    expect(independentAfter.status).toBe(200);
    expect(await independentAfter.text()).toBe(independentContent);
  }, 45_000);

  test("policy root CID revocation immediately denies an already issued signed GET ticket", async () => {
    const f = await fixture();
    const content = `signed-root-${nonce()}`;
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", content)).status).toBe(200);
    const ticket = await signedReadTicket(f);
    const before = await fetch(new URL(ticket.url, origin));
    expect(before.status).toBe(200);
    expect(await before.text()).toBe(content);

    const now = seconds();
    const revocation = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${f.policyRoot.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.registrarKey) });
    expect((await post("/revoke", revocation.authorization)).status).toBe(200);
    expect((await fetch(new URL(ticket.url, origin))).status).toBe(403);
  }, 30_000);
});

describe("TC-1149 policy grant revocation over real node HTTP", () => {
  test("explicit distinct UCAN grant revoke cuts off admitted S0 and descendants, admission, and writes", async () => {
    const f = await fixture();
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "before revoke")).status).toBe(200);
    expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).text()).toBe("before revoke");
    expect((await descendantInvoke(f, "tinycloud.kv/put", "descendant before revoke")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("descendant before revoke");
    const ordinary = await ordinaryChild(f);
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status).toBe(200);
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "ordinary before revoke")).status).toBe(200);
    expect((await descendantInvoke(f, "tinycloud.kv/put", "descendant before revoke")).status).toBe(200);
    expect(await ownerRead(f)).toBe("descendant before revoke");
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    const liveRegistration = await f.newRegistration();
    expect(liveRegistration.policyCid).not.toBe(f.registration.policyCid);
    expect(await registerPolicyV3(liveRegistration)).toMatchObject({ policyCid: liveRegistration.policyCid });

    // /revoke targets precisely this third-party grant CID, NOT the owner key.
    const now = seconds();
    const revocation = await signCompactUcanAuthorization({ issuerDid: f.ownerDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${f.grant.cid}`]: { "tinycloud.delegation/revoke": [{}] } }, facts: [{}], proofs: [],
      notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.ownerKey) });
    const revoked = await fetch(new URL("/revoke", origin), { method: "POST", headers: { Authorization: revocation.authorization } });
    expect(revoked.status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "forbidden S0 write")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "forbidden descendant write")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "forbidden ordinary write")).status);
    const laterChild = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.recipientDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [f.grant.cid],
      notBefore: seconds(), expiresAt: seconds() + 35, nonce: nonce(), sign: signer(f.registrarKey) });
    statusDenied((await post("/delegate", laterChild.authorization)).status);
    const laterDescendant = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: did(key()), attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
    // This exact S0-to-descendant admission succeeded before the cutoff.
    await Bun.sleep(Math.max(0, laterDescendant.payload.nbf * 1000 - Date.now() + 100));
    statusDenied((await post("/delegate", laterDescendant.authorization)).status);
    const freshRegistration = await f.newRegistration();
    expect(freshRegistration.policyCid).not.toBe(f.registration.policyCid);
    await expect(registerPolicyV3(freshRegistration)).rejects.toMatchObject({ status: 403 });
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  test("revoking a distinct wallet-signed SIWE/CACAO grant cuts off admitted policy sessions and ordinary descendants", async () => {
    const f = await fixture(300, "siwe");
    const ordinary = await ordinaryChild(f);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "SIWE S0 before revoke")).status).toBe(200);
    expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).text()).toBe("SIWE S0 before revoke");
    expect((await descendantInvoke(f, "tinycloud.kv/put", "SIWE descendant before revoke")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("SIWE descendant before revoke");
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "SIWE ordinary before revoke")).status).toBe(200);
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status).toBe(200);
    expect(await siweOwnerRead(f)).toBe("SIWE ordinary before revoke");
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    const liveRegistration = await f.newRegistration();
    expect(liveRegistration.policyCid).not.toBe(f.registration.policyCid);
    expect(await registerPolicyV3(liveRegistration)).toMatchObject({ policyCid: liveRegistration.policyCid });
    const now = seconds();
    const revocation = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${f.grant.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.registrarKey) });
    expect((await post("/revoke", revocation.authorization)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "denied SIWE S0")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "denied SIWE descendant")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "denied SIWE ordinary")).status);
    const laterChild = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.recipientDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [f.grant.cid],
      notBefore: seconds(), expiresAt: seconds() + 35, nonce: nonce(), sign: signer(f.registrarKey) });
    statusDenied((await post("/delegate", laterChild.authorization)).status);
    const laterDescendant = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: did(key()), attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
    await Bun.sleep(Math.max(0, laterDescendant.payload.nbf * 1000 - Date.now() + 100));
    statusDenied((await post("/delegate", laterDescendant.authorization)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    await expect(registerPolicyV3(await f.newRegistration())).rejects.toMatchObject({ status: 403 });
    expect(await siweOwnerRead(f)).toBe("SIWE ordinary before revoke");
  }, 45_000);

  test("short wallet SIWE sign-in naturally expires without shortening already admitted policy access", async () => {
    const f = await fixture(20, "owner-signin");
    if (!f.ownerNode?.session) throw new Error("owner sign-in session is unavailable");
    expect(f.registrarDid).toBe(f.ownerNode.session.verificationMethod.split("#", 1)[0]);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "wallet session before expiry")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("wallet session before expiry");
    // The proof is a real SDK wallet sign-in, but Phase 1 does not assign it a signed owner-self classification.
    // Fake timers cannot advance the separately running Node's SIWE expiry.
    await Bun.sleep(Math.max(0, (f.grantExpiresAt + 1) * 1000 - Date.now()));
    expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).text()).toBe("wallet session before expiry");
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "wallet S0 after expiry")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("wallet S0 after expiry");
    expect((await descendantInvoke(f, "tinycloud.kv/put", "wallet descendant after expiry")).status).toBe(200);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    // A newly signed-in wallet session is independent of the old policy registrar key.
    await f.ownerNode.signIn();
    await f.ownerNode.hostOwnedSpace("applications");
    expect(await siweOwnerRead(f)).toBe("wallet descendant after expiry");
  }, 45_000);

  test("registrar self-global key revoke cuts off signed policy roots, ordinary children, descendants and fresh admission", async () => {
    const f = await fixture();
    const ordinary = await ordinaryChild(f);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "S0 before key revoke")).status).toBe(200);
    expect((await descendantInvoke(f, "tinycloud.kv/put", "descendant before key revoke")).status).toBe(200);
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "ordinary before key revoke")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
    expect((await descendantInvoke(f, "tinycloud.kv/get")).status).toBe(200);
    expect((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status).toBe(200);
    expect(await ownerRead(f)).toBe("ordinary before key revoke");

    // A different principal may sign a structurally valid request, but cannot revoke this key.
    const outsiderKey = key();
    expect(did(outsiderKey)).not.toBe(f.registrarDid);
    expect((await keyRevocationRequest(f.registrarDid, outsiderKey, f.nodeDid)).status).toBe(403);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    const liveRegistration = await f.newRegistration();
    expect(liveRegistration.policyCid).not.toBe(f.registration.policyCid);
    expect(await registerPolicyV3(liveRegistration)).toMatchObject({ policyCid: liveRegistration.policyCid });
    expect((await keyRevocationRequest(f.registrarDid, f.registrarKey, f.nodeDid)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "denied S0")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "denied descendant")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/get")).status);
    statusDenied((await ordinaryInvoke(f, ordinary, "tinycloud.kv/put", "denied ordinary")).status);
    const laterChild = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.recipientDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [f.grant.cid],
      notBefore: seconds(), expiresAt: seconds() + 35, nonce: nonce(), sign: signer(f.registrarKey) });
    statusDenied((await post("/delegate", laterChild.authorization)).status);
    const freshRoot = await signCompactUcanRootAuthorization({ issuerDid: f.registrarDid, audienceDid: f.recipientDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}],
      notBefore: seconds(), expiresAt: seconds() + 35, nonce: nonce(), sign: signer(f.registrarKey) });
    statusDenied((await post("/delegate", freshRoot.authorization)).status);
    const laterDescendant = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: did(key()), attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
    await Bun.sleep(Math.max(0, laterDescendant.payload.nbf * 1000 - Date.now() + 100));
    statusDenied((await post("/delegate", laterDescendant.authorization)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    await expect(registerPolicyV3(await f.newRegistration())).rejects.toMatchObject({ status: 403 });
    expect(await ownerRead(f)).toBe("ordinary before key revoke");
  }, 30_000);

  test("recipient session-key self-global revoke kills S0, descendants and recipient-issued ordinary chain only", async () => {
    const f = await fixture();
    const ordinary = await ordinaryChild(f);
    const now = seconds();
    const ordinaryGrandchild = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: f.childDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [ordinary.cid],
      notBefore: now, expiresAt: Math.min(now + 35, ordinary.payload.exp - 1), nonce: nonce(), sign: signer(f.recipientKey) });
    await importDelegation(ordinaryGrandchild);
    const controlGrandchild = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: did(key()),
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [ordinary.cid],
      notBefore: now, expiresAt: Math.min(now + 35, ordinary.payload.exp - 1), nonce: nonce(), sign: signer(f.recipientKey) });
    await importDelegation(controlGrandchild);
    const controlRevoke = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${controlGrandchild.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: seconds(), expiresAt: seconds() + 30, nonce: nonce(), sign: signer(f.recipientKey) });
    expect((await post("/revoke", controlRevoke.authorization)).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "S0 before recipient revoke")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("S0 before recipient revoke");
    expect((await descendantInvoke(f, "tinycloud.kv/put", "descendant before recipient revoke")).status).toBe(200);
    expect((await ordinaryGrandchildInvoke(f, ordinaryGrandchild, "tinycloud.kv/get")).status).toBe(200);
    expect((await ordinaryGrandchildInvoke(f, ordinaryGrandchild, "tinycloud.kv/put", "ordinary grandchild before recipient revoke")).status).toBe(200);
    expect(await ownerRead(f)).toBe("ordinary grandchild before recipient revoke");

    expect((await f.mint()).cid).not.toBe(f.session.cid);
    expect((await keyRevocationRequest(f.recipientDid, f.recipientKey, f.nodeDid)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "denied recipient S0")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "denied recipient descendant")).status);
    statusDenied((await ordinaryGrandchildInvoke(f, ordinaryGrandchild, "tinycloud.kv/get")).status);
    statusDenied((await ordinaryGrandchildInvoke(f, ordinaryGrandchild, "tinycloud.kv/put", "denied recipient ordinary child")).status);
    const laterDescendant = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: did(key()), attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
    // The Node validates nbf on its own clock.
    await Bun.sleep(Math.max(0, laterDescendant.payload.nbf * 1000 - Date.now() + 100));
    statusDenied((await post("/delegate", laterDescendant.authorization)).status);
    const laterOrdinary = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: did(key()),
      attenuation: { [f.resource]: f.attenuation[f.resource] }, facts: [{}], proofs: [ordinary.cid],
      notBefore: seconds(), expiresAt: seconds() + 30, nonce: nonce(), sign: signer(f.recipientKey) });
    statusDenied((await post("/delegate", laterOrdinary.authorization)).status);
    const lateRevoke = await signCompactUcanAuthorization({ issuerDid: f.recipientDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${ordinaryGrandchild.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: seconds(), expiresAt: seconds() + 30, nonce: nonce(), sign: signer(f.recipientKey) });
    statusDenied((await post("/revoke", lateRevoke.authorization)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    expect(await ownerRead(f)).toBe("ordinary grandchild before recipient revoke");
  }, 30_000);

  test("owner self-global key revoke kills direct root authority but leaves an unrelated owner's space untouched", async () => {
    const f = await fixture();
    const independent = await fixture();
    const controlChild = await ordinaryChild(f);
    const beforeOwnerRevoke = await signCompactUcanAuthorization({ issuerDid: f.ownerDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${controlChild.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: seconds(), expiresAt: seconds() + 30, nonce: nonce(), sign: signer(f.ownerKey) });
    expect((await post("/revoke", beforeOwnerRevoke.authorization)).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "owner before revoke")).status).toBe(200);
    expect((await descendantInvoke(f, "tinycloud.kv/get")).status).toBe(200);
    expect((await descendantInvoke(f, "tinycloud.kv/put", "owner descendant before revoke")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "owner before revoke")).status).toBe(200);
    expect((await invoke(independent.session, independent.recipientKey, independent.recipientDid, independent.nodeDid, independent.resource, "tinycloud.kv/put", "unrelated before revoke")).status).toBe(200);
    expect(await ownerRead(f)).toBe("owner before revoke");
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    const liveRegistration = await f.newRegistration();
    expect(liveRegistration.policyCid).not.toBe(f.registration.policyCid);
    expect(await registerPolicyV3(liveRegistration)).toMatchObject({ policyCid: liveRegistration.policyCid });
    expect((await keyRevocationRequest(f.ownerDid, f.ownerKey, f.nodeDid)).status).toBe(200);
    statusDenied((await ownerGet(f)).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "denied owner-root write")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
    statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "denied owner descendant write")).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    await expect(registerPolicyV3(await f.newRegistration())).rejects.toMatchObject({ status: 403 });
    const lateOwnerRevoke = await signCompactUcanAuthorization({ issuerDid: f.ownerDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${f.grant.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: seconds(), expiresAt: seconds() + 30, nonce: nonce(), sign: signer(f.ownerKey) });
    statusDenied((await post("/revoke", lateOwnerRevoke.authorization)).status);
    expect(await (await invoke(independent.session, independent.recipientKey, independent.recipientDid, independent.nodeDid, independent.resource, "tinycloud.kv/get")).text()).toBe("unrelated before revoke");
    expect((await invoke(independent.session, independent.recipientKey, independent.recipientDid, independent.nodeDid, independent.resource, "tinycloud.kv/put", "unrelated after revoke")).status).toBe(200);
    expect(await ownerRead(independent)).toBe("unrelated after revoke");
  }, 30_000);

  test("rejects malformed target DIDs before accepting a scoped key tombstone", async () => {
    const f = await fixture();
    const spaceId = f.resource.split("/kv/", 1)[0]!;
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "unchanged")).status).toBe(200);
    for (const targetDid of ["did:key:", "did:Bad:recipient"]) {
      const signed = await signedKeyRevocation(targetDid, f.ownerKey, f.nodeDid, { kind: "space", spaceId });
      expect((await postKeyRevocation(signed)).status).toBe(400);
    }
    const control = await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get");
    expect(control.status).toBe(200);
    expect(await control.text()).toBe("unchanged");
  }, 30_000);

  test("committed key-revoke receipt is stable across self-revoke retries, while nonce conflicts and unrelated signers are rejected", async () => {
    const f = await fixture();
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "receipt control")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
    const requestNonce = nonce();
    const signed = await signedKeyRevocation(f.registrarDid, f.registrarKey, f.nodeDid, { kind: "global" }, requestNonce);
    const first = await postKeyRevocation(signed);
    expect(first.status).toBe(200);
    const receipt = await first.json();
    const repeated = await postKeyRevocation(signed);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(receipt);
    const outsider = await signedKeyRevocation(f.registrarDid, key(), f.nodeDid, { kind: "global" }, requestNonce);
    expect((await postKeyRevocation(outsider)).status).toBe(403);
    const changed = await signedKeyRevocation(f.registrarDid, f.registrarKey, f.nodeDid, { kind: "global" }, requestNonce, [], 39);
    expect(changed.authorization).not.toBe(signed.authorization);
    expect((await postKeyRevocation(changed)).status).toBe(403);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
  }, 30_000);

  test("live target-authorized recovery delegate can globally revoke only its enrolled target", async () => {
    const f = await fixture();
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "recovery-before")).status).toBe(200);
    const recoveryKey = key(), recoveryDid = did(recoveryKey), now = seconds();
    const scope = { kind: "global" } as const;
    const recovery = await signCompactUcanRootAuthorization({ issuerDid: f.registrarDid, audienceDid: recoveryDid,
      attenuation: { [`urn:tinycloud:key:${f.registrarDid}`]: {
        "tinycloud.key/revoke": [{ version: 1, targetDid: f.registrarDid, scope }] } },
      facts: [{}], notBefore: now - 2, expiresAt: now + 55, nonce: nonce(), sign: signer(f.registrarKey) });
    await importDelegation(recovery);
    const unrelated = await signedKeyRevocation(f.registrarDid, key(), f.nodeDid, scope, nonce(), [recovery.cid]);
    expect((await postKeyRevocation(unrelated)).status).toBe(403);
    const authorized = await signedKeyRevocation(f.registrarDid, recoveryKey, f.nodeDid, scope, nonce(), [recovery.cid]);
    expect((await postKeyRevocation(authorized)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    expect(await ownerRead(f)).toBe("recovery-before");
  }, 30_000);

  test("expired scoped recovery proof denies a fresh revoke but preserves its committed receipt", async () => {
    const f = await fixture();
    const recoveryKey = key(), recoveryDid = did(recoveryKey), now = seconds();
    const spaceId = f.resource.split("/kv/", 1)[0]!;
    const scope = { kind: "space", spaceId } as const;
    const recovery = await signCompactUcanRootAuthorization({ issuerDid: f.ownerDid, audienceDid: recoveryDid,
      attenuation: { [`urn:tinycloud:key:${f.recipientDid}`]: {
        "tinycloud.key/revoke": [{ version: 1, targetDid: f.recipientDid, scope }] } },
      facts: [{}], notBefore: now - 2, expiresAt: now + 10, nonce: nonce(), sign: signer(f.ownerKey) });
    await importDelegation(recovery);
    const signed = await signedKeyRevocation(f.recipientDid, recoveryKey, f.nodeDid, scope, nonce(), [recovery.cid]);
    const first = await postKeyRevocation(signed);
    expect(first.status).toBe(200);
    const receipt = await first.json();
    await Bun.sleep(Math.max(0, (now + 11) * 1000 - Date.now()));
    const exact = await postKeyRevocation(signed);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual(receipt);
    const fresh = await signedKeyRevocation(f.recipientDid, recoveryKey, f.nodeDid, scope, nonce(), [recovery.cid]);
    expect((await postKeyRevocation(fresh)).status).toBe(403);
  }, 30_000);

  test("a space owner revokes one recipient key only in its space; another owner's live grant still works", async () => {
    const first = await fixture();
    const second = await fixture(300, "ucan", first.recipientKey);
    expect(first.recipientDid).toBe(second.recipientDid);
    expect(first.ownerDid).not.toBe(second.ownerDid);
    expect((await invoke(first.session, first.recipientKey, first.recipientDid, first.nodeDid, first.resource, "tinycloud.kv/put", "first-before")).status).toBe(200);
    expect((await invoke(second.session, second.recipientKey, second.recipientDid, second.nodeDid, second.resource, "tinycloud.kv/put", "second-before")).status).toBe(200);
    const spaceId = first.resource.split("/kv/", 1)[0]!;
    const scope = { kind: "space", spaceId } as const;
    const requestNonce = nonce();
    const request = await signedKeyRevocation(first.recipientDid, first.ownerKey, first.nodeDid, scope, requestNonce);
    expect((await descendantInvoke(first, "tinycloud.kv/get")).status).toBe(200);
    expect((await first.mint()).cid).not.toBe(first.session.cid);
    expect((await postKeyRevocation(request)).status).toBe(200);
    const changed = await signedKeyRevocation(first.recipientDid, first.ownerKey, first.nodeDid, scope, requestNonce, [], 39);
    expect(changed.authorization).not.toBe(request.authorization);
    expect((await postKeyRevocation(changed)).status).toBe(409);
    statusDenied((await invoke(first.session, first.recipientKey, first.recipientDid, first.nodeDid, first.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(first.session, first.recipientKey, first.recipientDid, first.nodeDid, first.resource, "tinycloud.kv/put", "first-denied")).status);
    statusDenied((await descendantInvoke(first, "tinycloud.kv/get")).status);
    expect(await ownerRead(first)).toBe("first-before");
    expect(await (await invoke(second.session, second.recipientKey, second.recipientDid, second.nodeDid, second.resource, "tinycloud.kv/get")).text()).toBe("second-before");
    expect((await invoke(second.session, second.recipientKey, second.recipientDid, second.nodeDid, second.resource, "tinycloud.kv/put", "second-after")).status).toBe(200);
    expect((await descendantInvoke(second, "tinycloud.kv/get")).status).toBe(200);
    expect((await second.mint()).cid).not.toBe(second.session.cid);
    expect(await ownerRead(second)).toBe("second-after");
  }, 45_000);

  test("one multi-space policy keeps B-only access after an A-scoped recipient tombstone, but denies A and A+B", async () => {
    const f = await twoSpaceFixture();
    const spaceId = f.resource.split("/kv/", 1)[0]!;
    expect(spaceId).not.toBe(f.secondSpace);
    const request = await signedKeyRevocation(f.recipientDid, f.ownerKey, f.nodeDid, { kind: "space", spaceId });
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status).toBe(200);
    expect((await combinedSpaceRead(f)).status).toBe(200);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    expect((await postKeyRevocation(request)).status).toBe(200);

    const bRead = await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get");
    expect(bRead.status).toBe(200);
    expect(await bRead.text()).toBe(f.second);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/put", "B still writable")).status).toBe(200);
    expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).text()).toBe("B still writable");
    const bChild = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: f.childDid,
      attenuation: { [f.secondResource]: f.attenuation[f.secondResource] }, privateKey: f.recipientKey });
    await Bun.sleep(Math.max(0, bChild.payload.nbf * 1000 - Date.now() + 100));
    await importDelegation(bChild);
    const now = seconds();
    const bChildRead = await signCompactUcanAuthorization({ issuerDid: f.childDid, audienceDid: f.nodeDid,
      attenuation: { [f.secondResource]: { "tinycloud.kv/get": [
        { type: "xyz.tinycloud.resource/selector", kind: "exact", value: f.secondResource }] } },
      facts: [{ type: "tinycloud.policy.invocation/v1", policyCid: f.session.fact.policyCid, sessionCid: f.session.cid }],
      proofs: [bChild.cid], notBefore: now, expiresAt: Math.min(now + 40, bChild.payload.exp),
      nonce: nonce(), sign: signer(f.childKey) });
    const bChildResponse = await post("/invoke", bChildRead.authorization);
    expect(bChildResponse.status).toBe(200);
    expect(await bChildResponse.text()).toBe("B still writable");
    const aChild = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
      issuerDid: f.recipientDid, audienceDid: f.childDid,
      attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
    await Bun.sleep(Math.max(0, aChild.payload.nbf * 1000 - Date.now() + 100));
    statusDenied((await post("/delegate", aChild.authorization)).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "A denied")).status);
    statusDenied((await combinedSpaceRead(f)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    expect(await ownerRead(f)).toBe(f.first);
  }, 45_000);

  test("an A-scoped owner cutoff preserves B-only challenge and mint but denies A and mixed requests", async () => {
    const f = await twoSpaceFixture();
    const spaceId = f.resource.split("/kv/", 1)[0]!;
    const request = await signedKeyRevocation(f.ownerDid, f.ownerKey, f.nodeDid, { kind: "space", spaceId });
    expect((await ownerGet(f)).status).toBe(200);
    expect((await ownerGet({ ...f, resource: f.secondResource })).status).toBe(200);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    expect((await postKeyRevocation(request)).status).toBe(200);
    statusDenied((await ownerGet(f)).status);
    expect((await ownerGet({ ...f, resource: f.secondResource })).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    const bSession = await f.mint([f.secondCapability]);
    const bRead = await invoke(bSession, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get");
    expect(bRead.status).toBe(200);
    expect(await bRead.text()).toBe(f.second);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
  }, 45_000);

  test("global recipient tombstone denies both spaces under one policy", async () => {
    const f = await twoSpaceFixture();
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status).toBe(200);
    expect((await combinedSpaceRead(f)).status).toBe(200);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    expect((await keyRevocationRequest(f.recipientDid, f.recipientKey, f.nodeDid)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status);
    statusDenied((await combinedSpaceRead(f)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    expect(await ownerRead(f)).toBe(f.first);
  }, 45_000);

  test("generic CID revoke of the shared policy root denies both spaces", async () => {
    const f = await twoSpaceFixture();
    const now = seconds();
    const revoked = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.nodeDid,
      attenuation: { [`urn:cid:${f.policyRoot.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.registrarKey) });
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status).toBe(200);
    expect((await combinedSpaceRead(f)).status).toBe(200);
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    expect((await post("/revoke", revoked.authorization)).status).toBe(200);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
    statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.secondResource, "tinycloud.kv/get")).status);
    statusDenied((await combinedSpaceRead(f)).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    expect(await ownerRead(f)).toBe(f.first);
  }, 45_000);

  test("either policy root revoke denies admitted reads, writes and descendant admission", async () => {
    for (const rootName of ["policyRoot", "enforcementRoot"] as const) {
      const f = await fixture();
      expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", rootName)).status).toBe(200);
      expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status).toBe(200);
      expect((await descendantInvoke(f, "tinycloud.kv/get")).status).toBe(200);
      expect((await descendantInvoke(f, "tinycloud.kv/put", rootName)).status).toBe(200);
      const before = await ownerRead(f);
      expect((await f.mint()).cid).not.toBe(f.session.cid);
      const now = seconds();
      const revoked = await signCompactUcanAuthorization({ issuerDid: f.registrarDid, audienceDid: f.nodeDid,
        attenuation: { [`urn:cid:${f[rootName].cid}`]: { "tinycloud.delegation/revoke": [{}] } },
        facts: [{}], proofs: [], notBefore: now, expiresAt: now + 40, nonce: nonce(), sign: signer(f.registrarKey) });
      expect((await post("/revoke", revoked.authorization)).status).toBe(200);
      statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).status);
      statusDenied((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "denied")).status);
      statusDenied((await descendantInvoke(f, "tinycloud.kv/get")).status);
      statusDenied((await descendantInvoke(f, "tinycloud.kv/put", "denied")).status);
      const later = createCompactPolicyDescendant({ parentAuthorization: f.session.authorization, parentCid: f.session.cid,
        issuerDid: f.recipientDid, audienceDid: did(key()), attenuation: { [f.resource]: f.attenuation[f.resource] }, privateKey: f.recipientKey });
      await Bun.sleep(Math.max(0, later.payload.nbf * 1000 - Date.now() + 100));
      statusDenied((await post("/delegate", later.authorization)).status);
      await expect(f.mint()).rejects.toMatchObject({ status: 403 });
      expect(await ownerRead(f)).toBe(before);
    }
  }, 60_000);

  test("natural root expiry ends admitted access at the root deadline, not grant expiry", async () => {
    const f = await fixture(300, "ucan", undefined, 24);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "before root expiry")).status).toBe(200);
    const before = await ownerRead(f);
    // Sign fresh invocations against the expired proofs to exercise the Node,
    // rather than relying on the SDK helper rejecting an expired session.
    const expiredProofInvoke = async (descendant: boolean, action: "tinycloud.kv/get" | "tinycloud.kv/put") => {
      const now = seconds();
      const authorization = await signCompactUcanAuthorization({
        issuerDid: descendant ? f.childDid : f.recipientDid, audienceDid: f.nodeDid,
        attenuation: { [f.resource]: { [action]: [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: f.resource }] } },
        facts: [{ type: "tinycloud.policy.invocation/v1", policyCid: f.registration.policyCid, sessionCid: f.session.cid }],
        proofs: [descendant ? f.descendant.cid : f.session.cid],
        notBefore: now, expiresAt: now + 30, nonce: nonce(),
        sign: signer(descendant ? f.childKey : f.recipientKey),
      });
      return post("/invoke", authorization.authorization, action === "tinycloud.kv/put" ? "denied after root expiry" : undefined);
    };
    await Bun.sleep(Math.max(0, (f.rootExpiresAt + 1) * 1000 - Date.now()));
    statusDenied((await expiredProofInvoke(false, "tinycloud.kv/get")).status);
    statusDenied((await expiredProofInvoke(false, "tinycloud.kv/put")).status);
    statusDenied((await expiredProofInvoke(true, "tinycloud.kv/get")).status);
    statusDenied((await expiredProofInvoke(true, "tinycloud.kv/put")).status);
    await expect(f.mint()).rejects.toMatchObject({ status: 400 });
    expect(await ownerRead(f)).toBe(before);
  }, 45_000);

  test("natural third-party UCAN grant expiry retains admitted access and characterizes existing mint behavior", async () => {
    const f = await fixture(12);
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "before expiry")).status).toBe(200);
    // This integration test observes a real Node clock, not Bun's clock; wait once for the signed grant's exact expiry.
    await Bun.sleep(Math.max(0, (f.grantExpiresAt + 1) * 1000 - Date.now()));
    expect(await (await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/get")).text()).toBe("before expiry");
    expect((await invoke(f.session, f.recipientKey, f.recipientDid, f.nodeDid, f.resource, "tinycloud.kv/put", "S0 after expiry")).status).toBe(200);
    expect(await (await descendantInvoke(f, "tinycloud.kv/get")).text()).toBe("S0 after expiry");
    expect((await descendantInvoke(f, "tinycloud.kv/put", "descendant after expiry")).status).toBe(200);
    expect(await ownerRead(f)).toBe("descendant after expiry");
    // Phase 1 preserves the old mint behavior; the no-fresh-mint rule belongs to Phase 2.
    expect((await f.mint()).cid).not.toBe(f.session.cid);
    await expect(registerPolicyV3(await f.newRegistration())).rejects.toMatchObject({ status: 403 });
  }, 35_000);
});
