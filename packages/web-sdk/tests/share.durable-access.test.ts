import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, didKeyFromEd25519PublicKey, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { ReceivedShareImpl } from "../src/share/service";

const keyFor = (fill: number) => new Uint8Array(32).fill(fill);
const didFor = (key: Uint8Array) => didKeyFromEd25519PublicKey(ed25519.getPublicKey(key));
const vmFor = (did: string) => `${did}#${did.slice("did:key:".length)}`;
const wholeSeconds = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

/** Sign a compact UCAN of any lifetime; the library signers stop at 60 seconds. */
function sign(key: Uint8Array, payload: Record<string, unknown>) {
  const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(canonicalize(value)));
  const header = encode({ alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(ed25519.getPublicKey(key)) }, typ: "JWT", ucv: "0.10.0" });
  const body = encode(payload);
  return verifyCompactUcanAuthorization(`${header}.${body}.${toBase64Url(ed25519.sign(new TextEncoder().encode(`${header}.${body}`), key))}`);
}

/** An account recipient whose Node-minted sessions come from a stubbed credentials service. */
function accountShare(sessionLifetimes: readonly number[]) {
  const nodeKey = keyFor(81);
  const accountKey = keyFor(82);
  const nodeDid = didFor(nodeKey);
  const accountDid = didFor(accountKey);
  const enforcerDid = didFor(keyFor(83));
  const now = Math.floor(Date.now() / 1000);
  const resource = "tinycloud://owner-space/kv/shares/tc-531/notes.txt";
  const network = "urn:tinycloud:encryption:did:key:z6MkOwner:default";
  const envelope = {
    version: 3,
    actions: ["read"],
    resource: { kind: "exact", path: "shares/tc-531/notes.txt" },
    target: { origin: "https://node.example", nodeAudience: enforcerDid },
    attestedEnforcerBinding: { enforcerDid, nodeAudience: nodeDid },
    policyCid: "bafy-policy-durable",
    policy: {
      schema: "xyz.tinycloud.policy/policy/v2",
      ownerDid: "did:key:z6MkOwner",
      policyId: "pol_durable",
      expiresAt: wholeSeconds(now + 5400),
      capabilityCeiling: [
        { kind: "kv", resource, selector: "exact", actions: ["tinycloud.kv/get"] },
        { kind: "encryption", resource: network, action: "tinycloud.encryption/decrypt" },
      ],
    },
    policyRoot: { cid: "bafy-policy-root-durable" },
    enforcementRoot: { cid: "bafy-enforcement-root-durable" },
    contentSourceDigestHex: "1".repeat(64),
    expiry: wholeSeconds(now + 7200),
  } as any;
  const attenuation = {
    [resource]: { "tinycloud.kv/get": [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource }] },
    [network]: { "tinycloud.encryption/decrypt": [{}] },
  };
  const facts = {
    profile: "policy-session-ucan/v1", ownerDid: "did:key:z6MkOwner", policyId: "pol_durable",
    policyDigestHex: "0".repeat(64), policyCid: envelope.policyCid, policyDelegationCid: envelope.policyRoot.cid,
    enforcementDelegationCid: envelope.enforcementRoot.cid, contentSourceDigestHex: "1".repeat(64),
    capabilityCeilingHashHex: "2".repeat(64), nativeProjectionHashHex: "3".repeat(64), enforcerDid,
    nodeAudience: nodeDid, recipientDid: accountDid, challengeId: "challenge-durable", claimDigestHex: "4".repeat(64),
    claimJti: "claim-jti-durable", vpDigestHex: "5".repeat(64), credentialEvidenceDigestHex: "6".repeat(64),
    decisionContextDigestHex: "7".repeat(64), issuanceAuditDigestHex: "8".repeat(64), remainingRedelegationDepth: 8,
  };
  const admissions: Record<string, unknown>[] = [];
  const credentials = {
    ensure: async () => ({ credential: { claims: { email: "reader@example.com" } } }),
    admitPolicy: async (options: Record<string, unknown>) => {
      admissions.push(options);
      const lifetime = sessionLifetimes[Math.min(admissions.length - 1, sessionLifetimes.length - 1)]!;
      const session = sign(nodeKey, {
        att: attenuation, aud: accountDid, exp: Math.floor(Date.now() / 1000) + lifetime, fct: [facts], iss: vmFor(nodeDid),
        nbf: now - 20, nnc: `session-${admissions.length}`, prf: [envelope.policyRoot.cid, envelope.enforcementRoot.cid],
      });
      return { session: { authorization: session.authorization, cid: session.cid } };
    },
  };
  const responses: { invoke: { status: number; body: string } | Response | Error } = { invoke: { status: 200, body: "" } };
  const fetchFn = (async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path === "/delegate") return new Response(JSON.stringify({ cid: "imported" }), { status: 200 });
    if (path === "/invoke") {
      if (responses.invoke instanceof Error) throw responses.invoke;
      if (responses.invoke instanceof Response) return responses.invoke;
      return new Response(responses.invoke.body, { status: responses.invoke.status });
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
  const received = new ReceivedShareImpl(
    { kind: "account", holderDid: accountDid },
    { shareId: "share-durable" } as never,
    envelope,
    { claims: { email: "reader@example.com" } } as never,
    credentials as never,
    async (bytes) => ed25519.sign(bytes, accountKey),
    { identity: "account", interaction: { kind: "inline", mountTarget: "#credentials" } },
    fetchFn,
    "https://credentials.org/.well-known/opencredentials",
  );
  return { received, admissions, responses, envelope, delegate: didFor(keyFor(84)) };
}

test("an account recipient asks for a session as long as the share and is admitted again once it expires", async () => {
  const { received, admissions, envelope, delegate } = accountShare([2, 3600]);
  await received.delegate({ to: delegate });
  // The earlier of the envelope's and the policy's expiry.
  expect(admissions.map((options) => options.requestedExpiresAt)).toEqual([envelope.policy.expiresAt]);
  await Bun.sleep(2100);
  // The first session has expired: the next delegation re-admits rather than
  // reusing it, and extends the new session.
  const onward = await received.delegate({ to: delegate });
  expect(admissions).toHaveLength(2);
  expect(verifyCompactUcanAuthorization(onward.chain[0]!.authorization).payload.nnc).toBe("session-2");
});

for (const status of [401, 403] as const) {
  for (const body of ["", "Unauthorized Action: session refused", "Forbidden", "session expired"]) {
    test(`a ${status} share read with ${JSON.stringify(body)} re-admits cached access`, async () => {
      const { received, admissions, responses, delegate } = accountShare([3600]);
      responses.invoke = { status, body };
      await expect(received.get()).rejects.toMatchObject({
        status,
        message: `share invocation rejected: HTTP ${status}${body ? ` - ${body}` : ""}`,
      });
      expect(admissions).toHaveLength(1);
      await received.delegate({ to: delegate });
      expect(admissions).toHaveLength(2);
    });
  }
}

test("a typed server failure retains cached access despite misleading authorization text", async () => {
  const { received, admissions, responses, delegate } = accountShare([3600]);
  responses.invoke = { status: 500, body: "session expired (403)" };
  await expect(received.get()).rejects.toMatchObject({
    status: 500,
    message: "share invocation rejected: HTTP 500 - session expired (403)",
  });
  await received.delegate({ to: delegate });
  expect(admissions).toHaveLength(1);
});

test("a refused share read with a failed response stream still invalidates cached admission", async () => {
  const { received, admissions, responses, delegate } = accountShare([3600]);
  responses.invoke = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("body stream failed")); },
  }), { status: 403 });
  await expect(received.get()).rejects.toMatchObject({
    status: 403,
    message: "share invocation rejected: HTTP 403",
  });
  await received.delegate({ to: delegate });
  expect(admissions).toHaveLength(2);
});

for (const status of [401, 403, 500] as const) {
  test(`an untyped legacy ${status} suffix ${status === 500 ? "retains" : "invalidates"} cached access`, async () => {
    const { received, admissions, responses, delegate } = accountShare([3600]);
    responses.invoke = new Error(`legacy invocation rejected (${status})`);
    await expect(received.get()).rejects.toThrow(`legacy invocation rejected (${status})`);
    await received.delegate({ to: delegate });
    expect(admissions).toHaveLength(status === 500 ? 1 : 2);
  });
}
