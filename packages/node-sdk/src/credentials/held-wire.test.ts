import { describe, expect, test } from "bun:test";
import { acquireEmailProofWithIssuerKeys, completeEmailProofWithIssuerKeys, createMemoryEmailProofPendingStore, EmailProofError, requestEmailProofCode, restoreEmailProofPending, createEd25519HolderSigner, type EmailProofPending, type HolderSigner } from "./email-proof";
import { canonicalDigest } from "@tinycloud/sdk-core";
import { createHeldWitness, testAccountHolder, vectors, HELD_DESCRIPTOR_DIGEST, type HeldWitnessOptions } from "./test-support/held-witness";

// TC-2254 (contract v2.4): acquiring `tinycloud.email-held/v1` from the witness, against a fake witness built from the
// contract and its recorded vectors. Opt-in is per call. Every refusal asserts its network, mail and wallet cost.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE = "alice@example.com";
const T0 = Date.parse("2026-10-30T06:53:00Z");
const DID_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/** Server and client clocks. `slowBy` is how many ms the CLIENT is behind the server (negative: ahead). */
function world(witnessOptions: Omit<HeldWitnessOptions, "serverClock"> = {}, slowBy = 0, privateKey = ANVIL_0) {
  const time = { server: T0, slow: slowBy };
  const client = () => time.server - time.slow;
  const witness = createHeldWitness({ ...witnessOptions, serverClock: () => time.server });
  const holder = testAccountHolder(privateKey);
  const now = () => new Date(client());
  const advance = (ms: number) => { time.server += ms; };
  const input = (extra: Record<string, unknown> = {}) => ({ address: ALICE, holder, profile: HELD, allowHeldProfile: true as const, fetch: witness.fetch, now, ...extra });
  const issuerKeys = witness.issuerKeys;
  return { time, witness, holder, now, advance, input, issuerKeys, client };
}

async function failure(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}
const routes = (w: ReturnType<typeof createHeldWitness>) => w.calls.map((c) => c.route);

describe("happy path", () => {
  test("acquire with the per-call opt-in issues, verifies and returns the held credential", async () => {
    const w = world();
    const store = createMemoryEmailProofPendingStore();
    const result = await acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678", pendingStore: store }), w.issuerKeys);
    if (result.status !== "issued") throw new Error("expected issued");
    expect(result.warnings).toEqual([]);
    const { envelope, verified } = result.result;
    expect(envelope.profile.id).toBe(HELD);
    expect(envelope.holderDid).toBe(w.holder.did);
    expect(envelope.claims).toEqual({ email: ALICE, emailDomain: "example.com" });
    expect(result.result.credentialId).toBe(verified.credentialId);
    expect(verified.credentialId).toMatch(/^urn:uuid:/);
    expect(w.witness.mails.map((m) => m.kind)).toEqual(["code", "notice"]);
    expect(w.holder.calls.count).toBe(1);
    // Request step: catalog, create, state, challenge (the one mail). Complete step: catalog again, state, proof, binding, signature, issue, result.
    expect(routes(w.witness)).toEqual(["catalog", "create", "state", "challenge", "catalog", "state", "state", "proof", "state", "holder-binding", "holder-signature", "state", "issue", "state", "result"]);
    expect(await store.findLive(ALICE, w.now())).toBeUndefined();
  });

  test("the create request pins the descriptor and the held requirement digest, with the lowercased address", async () => {
    const w = world();
    const seen: Record<string, unknown>[] = [];
    const spy = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).endsWith("/v1/acquisitions")) seen.push(JSON.parse(String(init.body)));
      return w.witness.fetch(input, init);
    }, { preconnect: () => {} }) as typeof globalThis.fetch;
    await acquireEmailProofWithIssuerKeys(w.input({ address: "  Alice@Example.COM ", getCode: async () => "12345678", fetch: spy }), w.issuerKeys);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ descriptorDigest: HELD_DESCRIPTOR_DIGEST, requirementDigest: "Q_dnVOBsX_7fRjuzLPtCmDe_SKPiXW0Sxv0zSPb_Jd4", holderDid: w.holder.did, inputs: { email: ALICE }, profile: HELD, profileVersion: 1 });
    expect(Object.keys(seen[0]!)).toHaveLength(12);
  });

  test("the wallet receives UTF8(account domain), a NUL, then the JCS bytes of the binding the witness served", async () => {
    const w = world();
    await acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys);
    const bytes = w.holder.calls.seen[0]!;
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("tinycloud.credentials/account-binding/v1\u0000{")).toBe(true);
    const binding = JSON.parse(text.slice(text.indexOf("\u0000") + 1));
    expect(Object.keys(binding)).toHaveLength(20);
    expect(binding.holderDid).toBe(w.holder.did);
    expect(binding.normalizedClaimsDigest).toBe(vectors.happyPath.holder_binding.response.body.binding.normalizedClaimsDigest);
  });

  test("request then complete in two calls: the pending carries the server expiry and no opt-in", async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input());
    expect(pending.profile).toBe(HELD);
    expect(pending.serverExpiresAt).toBe(new Date(T0 + 600_000).toISOString());
    expect(JSON.stringify(pending)).not.toContain("allowHeld");
    const result = await completeEmailProofWithIssuerKeys({ pending, code: "12345678", holder: w.holder, fetch: w.witness.fetch, now: w.now, allowHeldProfile: true }, w.issuerKeys);
    expect(result.envelope.profile.id).toBe(HELD);
  });
});

describe("the opt-in is per call (C8.3)", () => {
  const cases: [string, (w: ReturnType<typeof world>) => Record<string, unknown>][] = [
    ["no opt-in", () => ({ allowHeldProfile: undefined })],
    ["opt-in false", () => ({ allowHeldProfile: false })],
    ["opt-in the string true", () => ({ allowHeldProfile: "true" })],
    ["opt-in 1", () => ({ allowHeldProfile: 1 })],
    ["a did:key holder", () => ({ allowHeldProfile: undefined, holder: createEd25519HolderSigner(DID_KEY, async (b) => b) })],
    ["a mixed-case address", () => ({ allowHeldProfile: undefined, address: "Alice@Example.COM" })],
  ];
  for (const [name, patch] of cases) {
    test(`${name}: PROFILE_UNAVAILABLE with zero network calls`, async () => {
      const w = world();
      const error = await failure(() => requestEmailProofCode(w.input(patch(w))));
      expect(error?.code).toBe("PROFILE_UNAVAILABLE");
      expect(w.witness.calls).toHaveLength(0);
    });
  }

  test("acquire without the opt-in is refused before any network call and no pending is stored", async () => {
    const w = world();
    const store = createMemoryEmailProofPendingStore();
    const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ allowHeldProfile: undefined, pendingStore: store, getCode: async () => "12345678" }), w.issuerKeys));
    expect(error?.code).toBe("PROFILE_UNAVAILABLE");
    expect(w.witness.calls).toHaveLength(0);
  });

  test("a held pending cannot be completed by a caller that did not opt in", async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input());
    const callsBefore = w.witness.calls.length;
    const error = await failure(() => completeEmailProofWithIssuerKeys({ pending, code: "12345678", holder: w.holder, fetch: w.witness.fetch, now: w.now }, w.issuerKeys));
    expect(error?.code).toBe("PROFILE_UNAVAILABLE");
    expect(w.witness.calls).toHaveLength(callsBefore);
    expect(w.holder.calls.count).toBe(0);
  });

  test("with the opt-in, the holder must be a canonical EIP-55 account with alg EIP191: anything else is HOLDER_INVALID before network", async () => {
    const w = world();
    const bad: HolderSigner[] = [
      createEd25519HolderSigner(DID_KEY, async (b) => b),
      { ...w.holder, did: w.holder.did.toLowerCase(), kid: `${w.holder.did.toLowerCase()}#blockchainAccountId` },
      { ...w.holder, kid: `${w.holder.did}#other` },
      { ...w.holder, alg: "EdDSA" },
      { ...w.holder, did: "did:pkh:eip155:137:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", kid: "did:pkh:eip155:137:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266#blockchainAccountId" },
      { ...w.holder, did: "did:pkh:eip155:1:0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266", kid: "did:pkh:eip155:1:0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266#blockchainAccountId" },
    ];
    for (const holder of bad) {
      const error = await failure(() => requestEmailProofCode(w.input({ holder })));
      expect(error?.code).toBe("HOLDER_INVALID");
    }
    expect(w.witness.calls).toHaveLength(0);
  });

  test("the ticket profile never runs for an account holder, with or without the opt-in", async () => {
    const w = world();
    for (const allowHeldProfile of [true, undefined]) {
      const error = await failure(() => requestEmailProofCode(w.input({ profile: "tinycloud.email-proof/v1", allowHeldProfile })));
      expect(error?.code).toBe("HOLDER_INVALID");
    }
    expect(w.witness.calls).toHaveLength(0);
  });
});

describe("address handling (S4, U5): trim, refuse non-ASCII, lowercase, then the witness's rules", () => {
  const recorded = (vectors.refusals as { name: string; request: { body: { inputs: { email: string } } } }[]).filter((r) => r.name.startsWith("create_malformed_input_"));
  test("the recorded malformed inputs: uppercase and a leading space are normalised and accepted; every other one is ADDRESS_INVALID with zero network calls", async () => {
    expect(recorded.length).toBeGreaterThanOrEqual(9);
    for (const r of recorded) {
      const email = r.request.body.inputs.email;
      const w = world();
      const normalised = r.name.endsWith("uppercase") || r.name.endsWith("leading_space");
      const error = await failure(() => requestEmailProofCode(w.input({ address: email })));
      if (normalised) {
        expect(error).toBeUndefined();
        expect(w.witness.mails[0]?.to).toBe(email.trim().toLowerCase());
      } else {
        expect([r.name, error?.code]).toEqual([r.name, "ADDRESS_INVALID"]);
        expect(w.witness.calls).toHaveLength(0);
      }
    }
  });

  test("an uppercase non-ASCII address is refused as non-ASCII before any lowercasing; so are the other listed forms", async () => {
    for (const address of ["a@éxample.com", "A@ÉXAMPLE.COM", "Alice <alice@example.com>", "+tag@example.com", "a@localhost", "a@b@example.com", `${"a".repeat(246)}@example.com`, `${"a".repeat(65)}@example.com`, "a@b..com", "a b@example.com"]) {
      const w = world();
      expect((await failure(() => requestEmailProofCode(w.input({ address }))))?.code).toBe("ADDRESS_INVALID");
      expect(w.witness.calls).toHaveLength(0);
    }
  });

  test("a mailed code goes to the lowercased mailbox and the requirement compares with that string", async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input({ address: "ALICE@EXAMPLE.COM" }));
    expect(pending.address).toBe(ALICE);
    expect(w.witness.mails[0]?.to).toBe(ALICE);
  });
});

describe("the binding is cross-checked against the SDK's own values before the wallet is called (S11 a)", () => {
  const mutations: [string, (b: Record<string, unknown>) => Record<string, unknown>][] = [
    ["type", (b) => ({ ...b, type: "tinycloud.credentials/holder-binding/v1" })],
    ["protocol", (b) => ({ ...b, protocol: "tinycloud.credentials/acquisition/v2" })],
    ["profileVersion", (b) => ({ ...b, profileVersion: 2 })],
    ["requestId", (b) => ({ ...b, requestId: "R".repeat(32) })],
    ["descriptorDigest", (b) => ({ ...b, descriptorDigest: "D".repeat(43) })],
    ["requirementDigest", (b) => ({ ...b, requirementDigest: "Q".repeat(43) })],
    ["holderDid", (b) => ({ ...b, holderDid: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })],
    ["issuer", (b) => ({ ...b, issuer: "did:web:evil.example" })],
    ["issuerKid", (b) => ({ ...b, issuerKid: "did:web:issuer.credentials.org#other" })],
    ["profile", (b) => ({ ...b, profile: "tinycloud.email-proof/v1" })],
    ["openerOrigin", (b) => ({ ...b, openerOrigin: "https://evil.example" })],
    ["completionOrigin", (b) => ({ ...b, completionOrigin: "https://evil.example" })],
    ["audience", (b) => ({ ...b, audience: "tinycloud://other" })],
    ["completionContext", (b) => ({ ...b, completionContext: "other-context" })],
    ["challengeNonce", (b) => ({ ...b, challengeNonce: "N".repeat(32) })],
    ["normalizedClaimsDigest (another mailbox)", (b) => ({ ...b, normalizedClaimsDigest: "kyc5jDA7koLzgm-dOmWhfGPXIOTOBmUdrSs-36KJJpd" })],
    ["issuedAt", (b) => ({ ...b, issuedAt: "2026-10-30T06:00:00Z" })],
    ["expiresAt", (b) => ({ ...b, expiresAt: "2026-10-30T09:00:00Z" })],
    ["credentialLifetimeSeconds", (b) => ({ ...b, credentialLifetimeSeconds: 3600 })],
    ["jti not a uuid", (b) => ({ ...b, jti: "J".repeat(32) })],
    ["an extra field", (b) => ({ ...b, extra: "x" })],
    ["a missing field", (b) => Object.fromEntries(Object.entries(b).filter(([key]) => key !== "completionContext"))],
  ];
  for (const [name, mutateBinding] of mutations) {
    test(`a substituted ${name} is refused SESSION_INVALID with zero wallet calls`, async () => {
      const w = world({ mutateBinding });
      const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys));
      expect([name, error?.code]).toEqual([name, "SESSION_INVALID"]);
      expect(w.holder.calls.count).toBe(0);
      expect(routes(w.witness)).not.toContain("holder-signature");
    });
  }
});

describe("the result is verified and cross-checked against the credential and the request (S13, C5.5 item 4)", () => {
  const bad: [string, HeldWitnessOptions][] = [
    ["claims.email differs from the credential", { mutateResult: (r) => ({ ...r, claims: { ...(r.claims as object), email: "bob@example.com" } }) }],
    ["an extra claim", { mutateResult: (r) => ({ ...r, claims: { ...(r.claims as object), name: "x" } }) }],
    ["validity.expiresAt differs", { mutateResult: (r) => ({ ...r, validity: { ...(r.validity as object), expiresAt: "2030-01-01T00:00:00Z" } }) }],
    ["validity.issuedAt differs", { mutateResult: (r) => ({ ...r, validity: { ...(r.validity as object), issuedAt: "2026-10-30T06:00:00Z" } }) }],
    ["credentialDigest is wrong", { mutateResult: (r) => ({ ...r, credentialDigest: "x".repeat(43) }) }],
    ["subject is another account", { mutateResult: (r) => ({ ...r, subject: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }) }],
    ["holderBinding.signingDomain is the ticket domain", { mutateResult: (r) => ({ ...r, holderBinding: { ...(r.holderBinding as object), signingDomain: "tinycloud.credentials/holder-binding/v1" } }) }],
    ["descriptorDigest is another", { mutateResult: (r) => ({ ...r, descriptorDigest: "D".repeat(43) }) }],
    ["status freshness differs", { mutateResult: (r) => ({ ...r, status: { type: "none", freshnessSeconds: 1 } }) }],
    ["the credential jti differs from the signed binding's (valid form)", { mutatePayload: (p) => ({ ...p, jti: "urn:uuid:11111111-1111-4111-8111-111111111111" }) }],
    ["the credential lifetime differs from the signed lifetime", { mutatePayload: (p) => ({ ...p, exp: (p.iat as number) + 86_400 }) }],
    ["the credential subject is another account", { mutatePayload: (p) => ({ ...p, sub: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8", holderBinding: { did: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signingDomain: "tinycloud.credentials/account-binding/v1" } }) }],
  ];
  for (const [name, opts] of bad) {
    test(`${name}: refused CREDENTIAL_INVALID`, async () => {
      const w = world(opts);
      const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys));
      expect([name, error?.code, error?.step]).toEqual([name, "CREDENTIAL_INVALID", "credential"]);
    });
  }

  test("a credential signed by another issuer key is refused; a flipped signature byte is refused", async () => {
    const other = createHeldWitness({ issuerSeed: new Uint8Array(32).fill(9) });
    const w = world();
    const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), other.issuerKeys));
    expect(error?.code).toBe("CREDENTIAL_INVALID");
    const tampered = world({ mutateResult: (r) => { const c = String(r.credential); return { ...r, credential: `${c.slice(0, c.indexOf("~") - 3)}AAA${c.slice(c.indexOf("~"))}` }; } });
    expect((await failure(() => acquireEmailProofWithIssuerKeys(tampered.input({ getCode: async () => "12345678" }), tampered.issuerKeys)))?.code).toBe("CREDENTIAL_INVALID");
  });
});

describe("clock skew (C5.5 item 4, C5.6, S11 a and d)", () => {
  const SLOW_OK = [1, 2, 60, 240, 299, 300].map((s) => s * 1000);
  for (const slow of SLOW_OK) {
    test(`a client ${slow / 1000} s slow is accepted`, async () => {
      const w = world({}, slow);
      const result = await acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys);
      expect(result.status).toBe("issued");
      expect(w.witness.mails.map((m) => m.kind)).toEqual(["code", "notice"]);
    });
  }

  for (const slow of [301_000, 360_000]) {
    test(`pre-flight: a client ${slow / 1000} s slow is refused CLIENT_CLOCK_SKEW at step request with 0 challenge calls, 0 mails, 0 wallet calls and no pending`, async () => {
      const w = world({}, slow);
      const store = createMemoryEmailProofPendingStore();
      const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678", pendingStore: store }), w.issuerKeys));
      expect([error?.code, error?.step, error?.recoverable]).toEqual(["CLIENT_CLOCK_SKEW", "request", false]);
      expect(error?.message).toBe("Your device clock is more than 5 minutes behind. Correct it and try again.");
      expect(routes(w.witness)).not.toContain("challenge");
      expect(w.witness.mails).toHaveLength(0);
      expect(w.holder.calls.count).toBe(0);
      expect(await store.findLive(ALICE, w.now())).toBeUndefined();
    });
  }

  for (const [label, fast, userMs] of [["6 min fast", 360_000, 0], ["6 min fast, the user takes 5 min", 360_000, 300_000], ["11 min fast", 660_000, 0], ["4 min fast, the user takes 5 min", 240_000, 300_000]] as const) {
    test(`fast clock (client-clock pending deadline): ${label} is accepted`, async () => {
      const w = world({}, -fast);
      const result = await acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => { w.advance(userMs); return "12345678"; } }), w.issuerKeys);
      expect(result.status).toBe("issued");
      expect(w.witness.mails.map((m) => m.kind)).toEqual(["code", "notice"]);
    });
  }

  test("the held pending deadline is createdAt + 600 s on the client clock; the ticket rule is unchanged", async () => {
    const w = world({}, -660_000);
    const pending = await requestEmailProofCode(w.input());
    expect(Date.parse(pending.expiresAt)).toBe(w.client() + 600_000);
  });

  test("post-issue: a clock that jumps back 4 minutes before issue is accepted, 6 minutes is CREDENTIAL_INVALID", async () => {
    for (const [back, expected] of [[240_000, "issued"], [360_000, "CREDENTIAL_INVALID"]] as const) {
      const w = world({ onRoute: (route) => { if (route === "holder-signature") w.time.slow += back; } });
      const error = await failure(() => acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys));
      expect(error?.code ?? "issued").toBe(expected);
      if (error) expect(error.step).toBe("credential");
    }
  });
});

describe("W1 acceptance: an EIP-55 address with hex letters and no lowercase letter is accepted (acceptanceW1)", () => {
  const W1 = vectors.acceptanceW1.account;
  test("the SDK accepts the account, sends the EIP-55 form, signs with the EIP-55 kid and its held verifier accepts the result", async () => {
    expect(W1.address).toBe(W1.address.slice(0, 2) + W1.address.slice(2).toUpperCase());
    const w = world({}, 0, W1.privateKeyHex);
    expect(w.holder.did).toBe(W1.did);
    const result = await acquireEmailProofWithIssuerKeys(w.input({ getCode: async () => "12345678" }), w.issuerKeys);
    expect(result.status).toBe("issued");
    expect(w.holder.calls.count).toBe(1);
    expect(w.holder.kid).toBe(`${W1.did}#blockchainAccountId`);
  });

  test("the recorded signature of the W1 flow's EIP-55 signing input is the SDK signer's", async () => {
    const holder = testAccountHolder(W1.privateKeyHex);
    const signature = await holder.sign(Uint8Array.from(Buffer.from(vectors.acceptanceW1.fromEip55SigningInputHex.replace(/^0x/, ""), "hex")));
    expect(`0x${Buffer.from(signature).toString("hex")}`).toBe(vectors.acceptanceW1.fromEip55Signature);
  });

  test("the refusals that stay refused: a mixed-case wrong checksum and an all-uppercase non-checksum address are HOLDER_INVALID before network", async () => {
    const w = world();
    for (const did of ["did:pkh:eip155:1:0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266", "did:pkh:eip155:1:0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266"]) {
      const holder = { ...w.holder, did, kid: `${did}#blockchainAccountId` };
      expect((await failure(() => requestEmailProofCode(w.input({ holder }))))?.code).toBe("HOLDER_INVALID");
    }
    expect(w.witness.calls).toHaveLength(0);
  });
});

describe("new public error code and recoverability", () => {
  test("CLIENT_CLOCK_SKEW is a public non-recoverable EmailProofError code with its default message", () => {
    const error = new EmailProofError("request", "CLIENT_CLOCK_SKEW");
    expect(error.recoverable).toBe(false);
    expect(error.message).toBe("Your device clock is more than 5 minutes behind. Correct it and try again.");
    expect(vectors.v24.errorCodePlacement).toBeDefined();
  });
});

describe("a pending that lacks the server expiry cannot be completed for held", () => {
  test("SESSION_INVALID before any network call", async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input());
    const { serverExpiresAt: _dropped, ...fields } = JSON.parse(JSON.stringify(pending)) as EmailProofPending & { serverExpiresAt?: string };
    const stripped = restoreEmailProofPending({ ...(fields as EmailProofPending), verifier: (pending as { verifier: string }).verifier });
    const before = w.witness.calls.length;
    const error = await failure(() => completeEmailProofWithIssuerKeys({ pending: stripped, code: "12345678", holder: w.holder, fetch: w.witness.fetch, now: w.now, allowHeldProfile: true }, w.issuerKeys));
    expect(error?.code).toBe("SESSION_INVALID");
    expect(w.witness.calls).toHaveLength(before);
  });
});

describe("an unavailable or unpinned held profile is PROFILE_UNAVAILABLE, with the catalog read as the only request (C6.4, C6.5, C7.2)", () => {
  const altered = (patch: (d: Record<string, any>) => void): Record<string, unknown> => { const d = structuredClone(vectors.descriptor.held) as Record<string, any>; patch(d); return d; };
  const cases: [string, (() => Promise<HeldWitnessOptions>)][] = [
    ["capability off (the held entry is listed with enabled false)", async () => ({ capability: false })],
    ["a descriptor changed by one byte under its old digest", async () => ({ catalogDescriptor: altered((d) => { d.lifecycle.requestTtlSeconds = 601; }) })],
    ["a descriptor changed by one byte with a recomputed digest (the pin refuses it)", async () => { const d = altered((d) => { d.lifecycle.requestTtlSeconds = 601; }); return { catalogDescriptor: d, catalogDigest: await canonicalDigest(d) }; }],
    ["another issuer origin with a recomputed digest", async () => { const d = altered((d) => { d.issuer.origin = "https://evil.example"; }); return { catalogDescriptor: d, catalogDigest: await canonicalDigest(d) }; }],
    ["another issuer did with a recomputed digest", async () => { const d = altered((d) => { d.issuer.did = "did:web:evil.example"; d.issuer.kid = "did:web:evil.example#controller"; }); return { catalogDescriptor: d, catalogDigest: await canonicalDigest(d) }; }],
    ["a mixed subject relationship and holder binding", async () => { const d = altered((d) => { d.subjectRelationship = "holder_is_subject"; }); return { catalogDescriptor: d, catalogDigest: await canonicalDigest(d) }; }],
  ];
  for (const [name, options] of cases) {
    test(name, async () => {
      const w = world(await options());
      const error = await failure(() => requestEmailProofCode(w.input()));
      expect([name, error?.code]).toEqual([name, "PROFILE_UNAVAILABLE"]);
      expect(routes(w.witness)).toEqual(["catalog"]);
      expect(w.holder.calls.count).toBe(0);
    });
  }
});
