import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { createHash } from "crypto";
import { readdir } from "fs/promises";
import {
  HOLDER_KEY_BINDING_PRESENTATION_SCHEMA,
  LISTEN_SQL_STATEMENT_CATALOG,
  POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA,
  POLICY_ENGINE_DENIAL_SCHEMA,
  POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES,
  TranscriptRequesterError,
  createTranscriptRequester,
  type RequesterHttpRequest,
  type RequesterHttpResponse,
  type RequesterSigningCapability,
  type RequesterTransport,
} from ".";
import {
  ED25519_JCS_SIGNATURE_SUITE,
  TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
  createAndSignRequesterPolicyEngineRecord,
  type PolicyCapability,
  type SignedObjectSigner,
} from "../policy";

const suitesFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/signature-suites.json",
).json()) as { ed25519: Record<string, { seed_hex: string; did: string }> };

const listenCatalogFixture = (await Bun.file(
  "test-fixtures/listen-catalog/listen-transcript-sql-statement-catalog.json",
).json()) as { catalog: typeof LISTEN_SQL_STATEMENT_CATALOG };

const wireManifest = (await Bun.file("test-fixtures/policy-engine-wire/manifest.json").json()) as {
  cases: Array<{ file: string; name: string; sha256: string }>;
  label: string;
};

const denialWireManifest = (await Bun.file(
  "test-fixtures/policy-engine-denial-wire/wire-denials/manifest.json",
).json()) as {
  fixtures: Record<string, { code: string; sha256: string; testRef: string }>;
  label: string;
  producerCommit: string;
};

type DenialMatrixRow = {
  code: string;
  layer: string;
  reachability?: string;
  httpStatus?: number;
  cpFRecord?: string;
};

const denialMatrix = (await Bun.file(
  "test-fixtures/policy-engine-denial-wire/denial-matrix-v0.json",
).json()) as DenialMatrixRow[];

const credentialDenialManifest = (await Bun.file(
  "test-fixtures/launch-credential-denials/manifest.json",
).json()) as {
  files: Array<{ path: string; sha256: string }>;
  fixedInvalidClasses: string[];
  schema: string;
};

type WireFixture = {
  name: string;
  request: { method: "POST"; path: string; body: unknown };
  response: { status: number; body: unknown };
};

type DenialWireFixture = {
  body: unknown;
  status: number;
};

type CredentialDenialFixture = {
  fixtureClass: string;
  expected: "accept" | "reject";
  expectedEngineWireCode: { code: string };
  evidencePresentation?: unknown;
};

const wireFixtures = new Map<string, WireFixture>();
for (const item of wireManifest.cases) {
  wireFixtures.set(
    item.name,
    (await Bun.file(`test-fixtures/policy-engine-wire/${item.file}`).json()) as WireFixture,
  );
}

const denialWireFixtures = new Map<string, DenialWireFixture>();
for (const file of Object.keys(denialWireManifest.fixtures)) {
  denialWireFixtures.set(
    file,
    (await Bun.file(`test-fixtures/policy-engine-denial-wire/wire-denials/${file}`).json()) as DenialWireFixture,
  );
}

const credentialDenialFixtures = new Map<string, CredentialDenialFixture>();
for (const item of credentialDenialManifest.files) {
  if (!item.path.endsWith(".json") || item.path === "manifest.json") {
    continue;
  }
  credentialDenialFixtures.set(
    item.path,
    (await Bun.file(`test-fixtures/launch-credential-denials/${item.path}`).json()) as CredentialDenialFixture,
  );
}

const credentialDenialEntries = [...credentialDenialFixtures.values()].filter((fixture) => fixture.expected === "reject");
const credentialRepresentativeFixtureClassByCode = new Map<string, string>([
  ["enrollment-binding-mismatch", "enrollment-binding-mismatch"],
  ["evidence-credential-invalid", "expired"],
  ["evidence-issuer-untrusted", "untrusted-issuer-did"],
  ["evidence-presentation-invalid", "malformed-presentation"],
]);

const NOW = new Date("2026-07-09T12:00:00Z");
const OWNER_DID = "did:pkh:eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const REQUESTER_DID = suitesFixture.ed25519.holder.did;
const GRANT_ISSUER_DID = suitesFixture.ed25519.grant_issuer.did;
const AUDIENCE = "tinycloud-sdk-requester-test";
const ENDPOINT = "https://policy.example.test";

const sqlStatement = LISTEN_SQL_STATEMENT_CATALOG.find(
  (statement) => statement.name === "listen.getConversation",
)!;

const sqlCapability: PolicyCapability = {
  service: "tinycloud.sql",
  space: "applications",
  path: "xyz.tinycloud.listen/conversations",
  actions: ["tinycloud.sql/read"],
  caveats: {
    mode: "constrained-statements",
    readOnly: true,
    statements: [sqlStatement],
  },
};

const uncaveatedSqlCapability: PolicyCapability = {
  service: "tinycloud.sql",
  space: "applications",
  path: "xyz.tinycloud.listen/conversations",
  actions: ["tinycloud.sql/read"],
};

const kvCapability: PolicyCapability = {
  service: "tinycloud.kv",
  space: "applications",
  path: "notebooks/nb_project_notes/docs/alice-note.md",
  actions: ["tinycloud.kv/get"],
};

let delegationCounter = 0;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function edSigner(name: string): SignedObjectSigner {
  const fixture = suitesFixture.ed25519[name];
  const seed = hexToBytes(fixture.seed_hex);
  return {
    suite: ED25519_JCS_SIGNATURE_SUITE,
    signerDid: fixture.did,
    signDigest: (digest) => ed25519.sign(digest, seed),
  };
}

function signingCapability(holderDid = REQUESTER_DID): RequesterSigningCapability {
  return {
    holderDid,
    keyId: `${holderDid}#device-1`,
    suite: "eddsa-ed25519-sha256-jcs-v1",
    signKeyBinding: (input) => `signed:${input.nonce}:${input.challengeId}:${input.issuedAt}`,
  };
}

class FixtureTransport implements RequesterTransport {
  readonly calls: RequesterHttpRequest[] = [];
  private readonly queue: Array<RequesterHttpResponse | Error>;

  constructor(queue: Array<RequesterHttpResponse | Error>) {
    this.queue = [...queue];
  }

  async request(request: RequesterHttpRequest): Promise<RequesterHttpResponse> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected request ${request.url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

async function bootstrap(overrides: Record<string, unknown> = {}) {
  const record = await createAndSignRequesterPolicyEngineRecord(
    {
      ownerDid: OWNER_DID,
      endpoint: ENDPOINT,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      expiresAt: "2026-07-09T13:00:00Z",
      ...(overrides.record ?? {}),
    },
    edSigner("policy_signer"),
  );
  return {
    schema: TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
    policyId: "pol_test_requester_flow",
    policyEngine: {
      endpoint: ENDPOINT,
      audience: AUDIENCE,
      supportedEvidenceVerifiers: ["w3c.vc/credential/v1"],
      signedRecord: record,
    },
    resourceHint: {
      resourceType: "listen.conversation",
      resourceId: "conv_456",
      requestedCapabilities: [sqlCapability, kvCapability],
    },
    ...(overrides.bootstrap ?? {}),
  };
}

async function wireBootstrap(resolveFixture: WireFixture) {
  const presentation = (resolveFixture.request.body as { presentation: Record<string, unknown> }).presentation;
  const endpoint = "https://policy-engine.example/v0";
  const record = await createAndSignRequesterPolicyEngineRecord(
    {
      ownerDid: OWNER_DID,
      endpoint,
      audience: presentation.audience as string,
      grantIssuerDid: (resolveFixture.response.body as { delegation: { issuerDid: string } }).delegation
        .issuerDid,
      expiresAt: "2026-06-12T00:10:00Z",
    },
    edSigner("policy_signer"),
  );
  return {
    schema: TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
    policyId: presentation.policyId,
    policyEngine: {
      endpoint,
      audience: presentation.audience,
      supportedEvidenceVerifiers: ["w3c.vc/credential/v1"],
      signedRecord: record,
    },
    resourceHint: {
      resourceType: "listen.conversation",
      resourceId: "conv_wire",
      requestedCapabilities: presentation.requestedCapabilities,
    },
  };
}

function challenge(nonce = "nonce-1234567890abcdef") {
  return {
    status: 200,
    body: {
      challenge: {
        schema: POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA,
        challengeId: `chal_${nonce}`,
        policyId: "pol_test_requester_flow",
        audience: AUDIENCE,
        nonce,
        challengeExpiresAt: "2026-07-09T12:01:00Z",
        acceptedSuites: ["eddsa-ed25519-sha256-jcs-v1"],
        signature: {
          suite: "eddsa-ed25519-sha256-jcs-v1",
          signerDid: `${GRANT_ISSUER_DID}#challenge`,
          value: "test-signature",
        },
      },
    },
  };
}

function challengeForPresentation(presentation: Record<string, unknown>) {
  return {
    status: 200,
    body: {
      challenge: {
        schema: POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA,
        challengeId: `chal_${presentation.nonce}`,
        policyId: presentation.policyId,
        audience: presentation.audience,
        nonce: presentation.nonce,
        challengeExpiresAt: "2026-06-12T00:08:00+00:00",
        acceptedSuites: ["eddsa-ed25519-sha256-jcs-v1"],
        signature: {
          suite: "eddsa-ed25519-sha256-jcs-v1",
          signerDid: `${GRANT_ISSUER_DID}#challenge`,
          value: "test-signature",
        },
      },
    },
  };
}

function delegation(capabilities: readonly PolicyCapability[], overrides: Record<string, unknown> = {}) {
  return {
    delegationId: `pdel_test_${++delegationCounter}`,
    policyId: "pol_test_requester_flow",
    issuerDid: GRANT_ISSUER_DID,
    holderDid: REQUESTER_DID,
    issuedAt: "2026-07-09T12:00:00Z",
    expiresAt: "2026-07-09T12:04:00Z",
    terminal: true,
    encoded: `tc-pdel-v0.${delegationCounter}`,
    capabilities,
    ...overrides,
  };
}

function resolve(capabilities: readonly PolicyCapability[], overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      delegation: delegation(capabilities, overrides),
    },
  };
}

function denial(code: string, status = 403): RequesterHttpResponse {
  return {
    status,
    body: {
      schema: POLICY_ENGINE_DENIAL_SCHEMA,
      code,
      message: `denied ${code}`,
    },
  };
}

function denialWireResponse(code: string): RequesterHttpResponse {
  const entry = Object.entries(denialWireManifest.fixtures).find(([, fixture]) => fixture.code === code);
  if (entry === undefined) {
    throw new Error(`missing denial wire fixture for ${code}`);
  }
  const fixture = denialWireFixtures.get(entry[0]);
  if (fixture === undefined) {
    throw new Error(`unloaded denial wire fixture ${entry[0]}`);
  }
  return {
    status: fixture.status,
    body: fixture.body,
  };
}

function nonceFor(label: string): string {
  return `nonce-${label.replaceAll("-", "")}-0000000000000000`.slice(0, 32);
}

const mountedRuntimeMatrixByCode = new Map(
  denialMatrix
    .filter((row) => row.reachability === "mounted-runtime")
    .map((row) => [row.code, row]),
);

const frozenVocabularyNonruntimeCodes = new Set(
  denialMatrix
    .filter((row) => row.layer === "FROZEN-VOCABULARY" && row.reachability !== "mounted-runtime")
    .map((row) => row.code),
);

function expectedStateForMatrixCode(code: string): "denied" | "access-ended" {
  return code === "policy-inactive" || code === "policy-expired" ? "access-ended" : "denied";
}

async function requester(transport: RequesterTransport, input = {}) {
  return createTranscriptRequester({
    bootstrap: await bootstrap(input),
    requesterDid: REQUESTER_DID,
    ownerDid: OWNER_DID,
    audience: AUDIENCE,
    grantIssuerDid: GRANT_ISSUER_DID,
    transport,
    signingCapability: signingCapability(),
    now: () => NOW,
    sleep: async () => {},
    random: () => 0,
  });
}

async function expectRequesterFailure(
  action: () => unknown | Promise<unknown>,
  code: string,
): Promise<TranscriptRequesterError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptRequesterError);
    expect((error as TranscriptRequesterError).code).toBe(code);
    return error as TranscriptRequesterError;
  }
  throw new Error(`expected requester failure ${code}`);
}

describe("TranscriptRequester bootstrap gate", () => {
  it("does not call /challenge until the signed policy engine record is verified", async () => {
    const transport = new FixtureTransport([challenge(), resolve([sqlCapability]), { status: 200, body: { rows: [] } }]);
    const client = await requester(transport);

    await client.readSql("listen.getConversation");

    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/read/sql/named`,
    ]);
  });

  it("fails closed before egress for tampered signature, owner mismatch, audience mismatch, and endpoint/audience substitution", async () => {
    const base = await bootstrap();
    const tampered = structuredClone(base);
    tampered.policyEngine.signedRecord.signature.value = `${tampered.policyEngine.signedRecord.signature.value.slice(0, -1)}A`;
    const transport = new FixtureTransport([]);

    await expectRequesterFailure(
      () =>
        createTranscriptRequester({
          bootstrap: tampered,
          requesterDid: REQUESTER_DID,
          ownerDid: OWNER_DID,
          audience: AUDIENCE,
          grantIssuerDid: GRANT_ISSUER_DID,
          transport,
          now: () => NOW,
        }),
      "requester-engine-record-signature-invalid",
    );
    await expectRequesterFailure(
      () => requester(transport, { record: { ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" } }),
      "requester-engine-record-owner-mismatch",
    );
    await expectRequesterFailure(
      () => requester(transport, { record: { audience: "wrong-audience" } }),
      "requester-engine-record-audience-mismatch",
    );
    await expectRequesterFailure(
      () =>
        requester(transport, {
          bootstrap: { policyEngine: { ...base.policyEngine, endpoint: "https://evil.example.test" } },
        }),
      "requester-engine-record-endpoint-mismatch",
    );
    await expectRequesterFailure(
      () =>
        requester(transport, {
          bootstrap: { policyEngine: { ...base.policyEngine, audience: "evil-audience" } },
        }),
      "requester-engine-record-audience-mismatch",
    );
    expect(transport.calls).toHaveLength(0);
  });
});

describe("TranscriptRequester challenge, resolve, and renewal", () => {
  it("mints a fresh nonce-bound holder presentation and performs SQL and KV reads", async () => {
    const transport = new FixtureTransport([
      challenge("nonce-fresh-0000001"),
      resolve([sqlCapability, kvCapability]),
      { status: 200, body: { rows: [{ id: "conv_456" }] } },
      { status: 200, body: { value: "hello" } },
    ]);
    const client = await requester(transport);

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ id: "conv_456" }] });
    await expect(client.readKv("notebooks/nb_project_notes/docs/alice-note.md")).resolves.toEqual({ value: "hello" });

    const resolveBody = transport.calls[1]!.body as {
      presentation: { schema: string; nonce: string; holderSignature: { value: string } };
    };
    expect(resolveBody.presentation.schema).toBe(HOLDER_KEY_BINDING_PRESENTATION_SCHEMA);
    expect(resolveBody.presentation.nonce).toBe("nonce-fresh-0000001");
    expect(resolveBody.presentation.holderSignature.value).toContain("nonce-fresh-0000001");
  });

  it("rejects a challenge response whose audience is not the bootstrap audience", async () => {
    const transport = new FixtureTransport([
      {
        ...challenge("nonce-wrong-audience"),
        body: {
          challenge: {
            ...challenge("nonce-wrong-audience").body.challenge,
            audience: "wrong-audience",
          },
        },
      },
    ]);
    const client = await requester(transport);

    await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-engine-response-invalid");
    expect(transport.calls.map((call) => call.url)).toEqual([`${ENDPOINT}/policy/v0/challenge`]);
  });

  it("restarts at /challenge after resolve 503 and never re-posts a burned presentation", async () => {
    const transport = new FixtureTransport([
      challenge("nonce-before-503"),
      { status: 503, body: { error: "down" } },
      challenge("nonce-after-0503"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [{ renewed: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 2,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ renewed: true }] });
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/read/sql/named`,
    ]);
    const resolveBodies = transport.calls
      .filter((call) => call.url.endsWith("/resolve"))
      .map((call) => call.body as { presentation: { nonce: string; holderSignature: { value: string } } });
    expect(resolveBodies.map((body) => body.presentation.nonce)).toEqual([
      "nonce-before-503",
      "nonce-after-0503",
    ]);
    expect(resolveBodies[1]!.presentation.holderSignature.value).toContain("nonce-after-0503");
  });

  it("restarts at /challenge after resolve transport timeout with unknown outcome", async () => {
    const transport = new FixtureTransport([
      challenge("nonce-before-timeout"),
      new Error("timeout after bytes left process"),
      challenge("nonce-after-timeout"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 2,
    });

    await client.readSql("listen.getConversation");
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/read/sql/named`,
    ]);
  });

  it("keeps bounded retry/backoff structurally challenge-only before a nonce is minted", async () => {
    const transport = new FixtureTransport([
      { status: 503, body: { error: "down" } },
      { status: 503, body: { error: "still-down" } },
      { status: 503, body: { error: "done" } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 3,
    });

    const error = await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-engine-unreachable");
    expect(error.state).toBe("unreachable");
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/challenge`,
    ]);
  });

  it("retries resolve transport failures with fresh challenges and then surfaces unreachable", async () => {
    const transport = new FixtureTransport([
      challenge("nonce-timeout-000001"),
      new Error("timeout 1"),
      challenge("nonce-timeout-000002"),
      new Error("timeout 2"),
      challenge("nonce-timeout-000003"),
      new Error("timeout 3"),
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 3,
    });

    const error = await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-engine-unreachable");
    expect(error.state).toBe("unreachable");
    expect(transport.calls.filter((call) => call.url.endsWith("/challenge"))).toHaveLength(3);
    expect(transport.calls.filter((call) => call.url.endsWith("/resolve"))).toHaveLength(3);
    expect(
      transport.calls
        .filter((call) => call.url.endsWith("/resolve"))
        .map((call) => (call.body as { presentation: { nonce: string } }).presentation.nonce),
    ).toEqual(["nonce-timeout-000001", "nonce-timeout-000002", "nonce-timeout-000003"]);
  });

  it("does not retry a parseable 4xx denial or reuse its nonce", async () => {
    const transport = new FixtureTransport([
      challenge("nonce-denied-000001"),
      denialWireResponse("requested-capabilities-exceeded"),
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 3,
    });

    const error = await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "policy-engine-denied-requested-capabilities-exceeded",
    );
    expect(error.state).toBe("denied");
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
    ]);
    expect((transport.calls[1]!.body as { presentation: { nonce: string } }).presentation.nonce).toBe(
      "nonce-denied-000001",
    );
  });

  it("surfaces typed renewal-required when no permitted signing capability is available", async () => {
    const transport = new FixtureTransport([]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      now: () => NOW,
    });

    const error = await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-renewal-required");
    expect(error.state).toBe("renewal-required");
    expect(transport.calls).toHaveLength(0);
  });

  it("surfaces renewal-required for a mismatched signing capability without egress", async () => {
    const transport = new FixtureTransport([]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(OWNER_DID),
      now: () => NOW,
    });

    const error = await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-renewal-required");
    expect(error.state).toBe("renewal-required");
    expect(transport.calls).toHaveLength(0);
  });

  it("does not submit the same challenge nonce twice", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-reused-000001"),
      resolve([sqlCapability], { expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-reused-000001"),
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:11Z");
    await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-challenge-reused");
    expect(transport.calls.filter((call) => call.url.endsWith("/resolve"))).toHaveLength(1);
  });

  it("runs access-triggered renewal before a read that needs it", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-old-000000001"),
      resolve([sqlCapability], { expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-new-000000001"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [{ renewed: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:41Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ renewed: true }] });
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/read/sql/named`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/read/sql/named`,
    ]);
  });

  it("renews at the near-expiry window with a fresh nonce after an unreachable renewal attempt", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-initial-00001"),
      resolve([sqlCapability], { expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-renewal-0001"),
      { status: 503, body: { error: "temporarily down" } },
      challenge("nonce-renewal-0002"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [{ renewed: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 2,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [] });
    current = new Date("2026-07-09T12:00:10Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ renewed: true }] });
    expect(
      transport.calls
        .filter((call) => call.url.endsWith("/resolve"))
        .map((call) => (call.body as { presentation: { nonce: string } }).presentation.nonce),
    ).toEqual(["nonce-initial-00001", "nonce-renewal-0001", "nonce-renewal-0002"]);
  });
});

describe("TranscriptRequester delegation import and containment", () => {
  it("rejects wider capability, wrong holder, and excessive TTL", async () => {
    await expectRequesterFailure(async () => {
      const client = await requester(new FixtureTransport([challenge(), resolve([
        { ...kvCapability, path: "notebooks/nb_project_notes/docs/bob-note.md" },
      ])]));
      await client.readKv("notebooks/nb_project_notes/docs/alice-note.md");
    }, "requester-delegation-capability-wider");

    for (const [overrides, code] of [
      [{ holderDid: OWNER_DID }, "requester-delegation-wrong-holder"],
      [{ issuerDid: OWNER_DID }, "requester-delegation-invalid"],
      [{ expiresAt: "2026-07-09T12:05:01Z" }, "requester-delegation-ttl-excessive"],
    ] as const) {
      await expectRequesterFailure(async () => {
        const client = await requester(new FixtureTransport([challenge(), resolve([sqlCapability], overrides)]));
        await client.readSql("listen.getConversation");
      }, code);
    }
  });

  it("rejects out-of-capability SQL and KV reads before wire", async () => {
    const sqlOnly = await requester(new FixtureTransport([
      challenge(),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [] } },
    ]));
    await sqlOnly.readSql("listen.getConversation");
    await expectRequesterFailure(
      () => sqlOnly.readKv("notebooks/nb_project_notes/docs/alice-note.md"),
      "requester-access-not-contained",
    );

    const kvOnly = await requester(new FixtureTransport([
      challenge(),
      resolve([kvCapability]),
      { status: 200, body: { value: "hello" } },
    ]));
    await kvOnly.readKv("notebooks/nb_project_notes/docs/alice-note.md");
    await expectRequesterFailure(
      () => kvOnly.readSql("listen.getConversation"),
      "requester-access-not-contained",
    );
  });

  it("maps server-side denial, unreachable, and policy-inactive renewal distinctly", async () => {
    await expectRequesterFailure(async () => {
      const client = await requester(new FixtureTransport([challenge(), resolve([sqlCapability]), denial("capability-not-contained")]));
      await client.readSql("listen.getConversation");
    }, "policy-engine-denied-capability-not-contained");

    await expectRequesterFailure(async () => {
      const client = await requester(new FixtureTransport([challenge(), resolve([sqlCapability]), { status: 503, body: {} }]));
      await client.readSql("listen.getConversation");
    }, "requester-access-unreachable");

    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-before-revoke"),
      resolve([sqlCapability], { expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-after-revoke"),
      denialWireResponse("policy-inactive"),
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });
    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:41Z");
    await expectRequesterFailure(() => client.readSql("listen.getConversation"), "policy-engine-denied-policy-inactive");
    expect(client.accessState).toBe("access-ended");
    const callsAfterPolicyInactive = transport.calls.length;
    await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-access-ended");
    expect(transport.calls).toHaveLength(callsAfterPolicyInactive);
  });
});

describe("TranscriptRequester fixture conformance", () => {
  it("keeps the SDK Listen SQL catalog byte-exact with the vendored catalog", () => {
    expect(LISTEN_SQL_STATEMENT_CATALOG).toEqual(listenCatalogFixture.catalog);
  });

  it("pins refresh semantics to the vendored resolve-happy delegation fields", () => {
    const happy = wireFixtures.get("resolve-happy")!;
    const delegation = (happy.response.body as { delegation: Record<string, unknown> }).delegation;
    expect(Object.keys(delegation).sort()).toEqual([
      "capabilities",
      "delegationId",
      "encoded",
      "expiresAt",
      "holderDid",
      "issuedAt",
      "issuerDid",
      "policyId",
      "terminal",
    ]);
    expect(delegation.terminal).toBe(true);
    expect(delegation).not.toHaveProperty("refreshOnly");
    expect(delegation).not.toHaveProperty("maxTtlSeconds");
  });

  it("derives renewal timing from serialized issuedAt/expiresAt fields, not terminal", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-terminal-false-old"),
      resolve([sqlCapability], { terminal: false, expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-terminal-false-new"),
      resolve([sqlCapability], { terminal: false }),
      { status: 200, body: { rows: [{ renewed: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      transport,
      signingCapability: signingCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [] });
    current = new Date("2026-07-09T12:00:11Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ renewed: true }] });
  });

  it("rejects unvendored resolve response envelopes", async () => {
    const client = await requester(new FixtureTransport([
      challenge(),
      { status: 200, body: { portableDelegation: delegation([sqlCapability]) } },
    ]));

    await expectRequesterFailure(() => client.readSql("listen.getConversation"), "requester-engine-response-invalid");
  });

  it("matches the producer-derived resolve-happy request and response wire bodies exactly", async () => {
    const happy = wireFixtures.get("resolve-happy")!;
    const presentation = (happy.request.body as { presentation: Record<string, unknown> }).presentation;
    let current = new Date("2026-06-12T00:03:00Z");
    const transport = new FixtureTransport([
      challengeForPresentation(presentation),
      happy.response,
      { status: 200, body: { rows: [{ wire: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await wireBootstrap(happy),
      requesterDid: presentation.holderDid as string,
      ownerDid: OWNER_DID,
      audience: presentation.audience as string,
      grantIssuerDid: (happy.response.body as { delegation: { issuerDid: string } }).delegation.issuerDid,
      transport,
      signingCapability: {
        holderDid: presentation.holderDid as string,
        keyId: `${presentation.holderDid as string}#fixture`,
        suite: (presentation.holderSignature as { suite: string }).suite,
        holderBinding: presentation.holderBinding,
        eligibleSubjectDid: presentation.eligibleSubjectDid as string,
        signGrantPresentation: () => (presentation.holderSignature as { value: string }).value,
        signKeyBinding: () => {
          throw new Error("signGrantPresentation should be used for fixture conformance");
        },
      },
      holderBinding: presentation.holderBinding,
      eligibleSubjectDid: presentation.eligibleSubjectDid as string,
      presentationTtlSeconds: 90,
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({ rows: [{ wire: true }] });
    expect(transport.calls[0]!.body).toEqual(wireFixtures.get("challenge-happy")!.request.body);
    expect(transport.calls[1]!.body).toEqual(happy.request.body);
    expect(client.accessState).toBe("active");
    current = new Date("2026-06-12T00:04:01Z");
    expect(client.accessState).toBe("needs-renewal");
  });

  it("maps every producer-derived denial fixture to its distinct typed denial", async () => {
    const denialCases = [
      ["challenge-unknown-field", "policy-engine-denied-schema-invalid"],
      ["challenge-unknown-policy", "policy-engine-denied-policy-not-found"],
      ["resolve-replay-consumed-nonce", "policy-engine-denied-challenge-nonce-consumed"],
      ["resolve-unknown-field", "policy-engine-denied-schema-invalid"],
      ["resolve-nonce-substituted-without-resign", "policy-engine-denied-holder-signature-invalid"],
      ["resolve-requested-capabilities-hash-mismatch", "policy-engine-denied-requested-capabilities-hash-mismatch"],
    ] as const;

    for (const [fixtureName, expectedCode] of denialCases) {
      const fixture = wireFixtures.get(fixtureName)!;
      const error = await expectRequesterFailure(async () => {
        if (fixtureName.startsWith("challenge-")) {
          const client = await requester(new FixtureTransport([fixture.response]));
          await client.readSql("listen.getConversation");
          return;
        }
        const resolveHappy = wireFixtures.get("resolve-happy")!;
        const presentation = (resolveHappy.request.body as { presentation: Record<string, unknown> }).presentation;
        const client = await createTranscriptRequester({
          bootstrap: await wireBootstrap(resolveHappy),
          requesterDid: presentation.holderDid as string,
          ownerDid: OWNER_DID,
          audience: presentation.audience as string,
          grantIssuerDid: (resolveHappy.response.body as { delegation: { issuerDid: string } }).delegation.issuerDid,
          transport: new FixtureTransport([challengeForPresentation(presentation), fixture.response]),
          signingCapability: signingCapability(presentation.holderDid as string),
          holderBinding: presentation.holderBinding,
          eligibleSubjectDid: presentation.eligibleSubjectDid as string,
          now: () => new Date("2026-06-12T00:03:00Z"),
          sleep: async () => {},
          random: () => 0,
        });
        await client.readSql("listen.getConversation");
      }, expectedCode);
      expect(error.state).toBe("denied");
      expect(error.status).toBe(fixture.response.status);
      expect(error.denialCode).toBe(
        (fixture.response.body as { error: { code: string } }).error.code,
      );
    }
  });

  it("maps every mounted-runtime layer-E denial fixture to its matrix state", async () => {
    for (const [file, manifestEntry] of Object.entries(denialWireManifest.fixtures)) {
      const matrix = mountedRuntimeMatrixByCode.get(manifestEntry.code);
      expect(matrix, `${manifestEntry.code} must be mounted-runtime in denial-matrix-v0`).toBeDefined();
      const fixture = denialWireFixtures.get(file)!;
      expect(fixture.status).toBe(matrix!.httpStatus);
      expect(fixture.status).toBeLessThan(500);

      const transport = new FixtureTransport([
        challenge(nonceFor(manifestEntry.code)),
        { status: fixture.status, body: fixture.body },
      ]);
      const client = await createTranscriptRequester({
        bootstrap: await bootstrap(),
        requesterDid: REQUESTER_DID,
        ownerDid: OWNER_DID,
        audience: AUDIENCE,
        grantIssuerDid: GRANT_ISSUER_DID,
        transport,
        signingCapability: signingCapability(),
        now: () => NOW,
        sleep: async () => {},
        random: () => 0,
        engineRetryAttempts: 3,
      });

      const error = await expectRequesterFailure(
        () => client.readSql("listen.getConversation"),
        `policy-engine-denied-${manifestEntry.code}`,
      );
      expect(error.state).toBe(expectedStateForMatrixCode(manifestEntry.code));
      expect(error.state).not.toBe("unreachable");
      expect(error.denialCode).toBe(manifestEntry.code);
      expect(error.status).toBe(fixture.status);
      expect(transport.calls.map((call) => call.url)).toEqual([
        `${ENDPOINT}/policy/v0/challenge`,
        `${ENDPOINT}/policy/v0/resolve`,
      ]);
    }
  });

  it("keeps requester denial expectations to mounted-runtime producible codes", () => {
    const fixtureCodes = new Set(Object.values(denialWireManifest.fixtures).map((fixture) => fixture.code));
    const credentialExpectedCodes = new Set(
      credentialDenialEntries.map((fixture) => fixture.expectedEngineWireCode.code),
    );

    for (const row of denialMatrix.filter((item) => item.reachability === "mounted-runtime")) {
      expect(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES).toContain(row.code);
      expect(fixtureCodes.has(row.code)).toBe(true);
    }
    for (const frozen of frozenVocabularyNonruntimeCodes) {
      expect(fixtureCodes.has(frozen)).toBe(false);
      expect(credentialExpectedCodes.has(frozen)).toBe(false);
    }
  });

  it("surfaces one credential-evidence representative per expected engine wire code", async () => {
    expect([...credentialRepresentativeFixtureClassByCode.keys()].sort()).toEqual([
      "enrollment-binding-mismatch",
      "evidence-credential-invalid",
      "evidence-issuer-untrusted",
      "evidence-presentation-invalid",
    ]);

    for (const [code, fixtureClass] of credentialRepresentativeFixtureClassByCode) {
      const fixture = credentialDenialEntries.find((item) => item.fixtureClass === fixtureClass);
      expect(fixture, `${fixtureClass} must exist as the ${code} representative`).toBeDefined();
      expect(fixture!.expectedEngineWireCode.code).toBe(code);
      const transport = new FixtureTransport([
        challenge(nonceFor(`cred-${code}`)),
        denialWireResponse(code),
      ]);
      const client = await createTranscriptRequester({
        bootstrap: await bootstrap(),
        requesterDid: REQUESTER_DID,
        ownerDid: OWNER_DID,
        audience: AUDIENCE,
        grantIssuerDid: GRANT_ISSUER_DID,
        transport,
        signingCapability: signingCapability(),
        evidence: fixture!.evidencePresentation === undefined ? undefined : [fixture!.evidencePresentation],
        now: () => NOW,
        sleep: async () => {},
        random: () => 0,
      });

      const error = await expectRequesterFailure(
        () => client.readSql("listen.getConversation"),
        `policy-engine-denied-${code}`,
      );
      expect(error.state).toBe(expectedStateForMatrixCode(code));
      expect(error.denialCode).toBe(code);
    }
  });

  it("covers every launch credential fixture mapping with exactly one representative per engine code", () => {
    const manifestInvalidClasses = new Set(credentialDenialManifest.fixedInvalidClasses);
    const mappingByClass = new Map<string, string>();
    const classesByCode = new Map<string, Set<string>>();
    const representativeCountsByCode = new Map<string, number>();

    for (const fixture of credentialDenialEntries) {
      expect(manifestInvalidClasses.has(fixture.fixtureClass), `${fixture.fixtureClass} must be manifest-listed`).toBe(true);
      expect(mappingByClass.has(fixture.fixtureClass), `${fixture.fixtureClass} must map once`).toBe(false);
      const code = fixture.expectedEngineWireCode.code;
      mappingByClass.set(fixture.fixtureClass, code);

      if (credentialRepresentativeFixtureClassByCode.get(code) === fixture.fixtureClass) {
        representativeCountsByCode.set(code, (representativeCountsByCode.get(code) ?? 0) + 1);
      }

      const classes = classesByCode.get(code) ?? new Set<string>();
      classes.add(fixture.fixtureClass);
      classesByCode.set(code, classes);
    }

    expect([...mappingByClass.keys()].sort()).toEqual([...manifestInvalidClasses].sort());
    expect(Object.fromEntries([...mappingByClass].sort())).toEqual({
      "enrollment-binding-mismatch": "enrollment-binding-mismatch",
      expired: "evidence-credential-invalid",
      "malformed-presentation": "evidence-presentation-invalid",
      "missing-required-disclosure": "evidence-credential-invalid",
      "not-yet-valid": "evidence-credential-invalid",
      "subject-mismatch": "evidence-credential-invalid",
      "untrusted-issuer-did": "evidence-issuer-untrusted",
      "wrong-issuer-signature": "evidence-credential-invalid",
      "wrong-vct": "evidence-credential-invalid",
    });

    for (const [code, classes] of classesByCode) {
      expect(mountedRuntimeMatrixByCode.has(code), `${code} must be a mounted-runtime denial code`).toBe(true);
      expect(representativeCountsByCode.get(code), `${code} must have exactly one representative case`).toBe(1);
      expect(credentialDenialEntries.filter((fixture) => fixture.expectedEngineWireCode.code === code)).toHaveLength(
        classes.size,
      );
    }
    expect(credentialRepresentativeFixtureClassByCode.size).toBe(classesByCode.size);
  });

  it("consumes every policy-engine-wire manifest case and pins fixture bytes", async () => {
    expect(wireManifest.label).toBe("confirmed from code: policy-engine service implementation @ 8c4cabbf5");
    const consumed = new Set([
      "challenge-happy",
      "challenge-unknown-field",
      "challenge-unknown-policy",
      "resolve-happy",
      "resolve-replay-consumed-nonce",
      "resolve-unknown-field",
      "resolve-nonce-substituted-without-resign",
      "resolve-requested-capabilities-hash-mismatch",
    ]);

    for (const item of wireManifest.cases) {
      expect(consumed.has(item.name)).toBe(true);
      const bytes = await Bun.file(`test-fixtures/policy-engine-wire/${item.file}`).arrayBuffer();
      expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(item.sha256);
    }
  });

  it("pins policy-engine-denial-wire manifest completeness and fixture bytes", async () => {
    expect(denialWireManifest.producerCommit).toBe("8c4cabbf56e51c7e37484c060ffd4a6d51521101");
    const actualFiles = (await readdir("test-fixtures/policy-engine-denial-wire/wire-denials"))
      .filter((file) => file.endsWith(".json") && file !== "manifest.json")
      .sort();
    expect(actualFiles).toEqual(Object.keys(denialWireManifest.fixtures).sort());

    for (const [file, fixture] of Object.entries(denialWireManifest.fixtures)) {
      const bytes = await Bun.file(`test-fixtures/policy-engine-denial-wire/wire-denials/${file}`).arrayBuffer();
      expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(fixture.sha256);
      expect((denialWireFixtures.get(file)!.body as { error: { code: string } }).error.code).toBe(fixture.code);
    }
  });

  it("pins launch-credential-denials manifest completeness and fixture bytes", async () => {
    expect(credentialDenialManifest.schema).toBe("xyz.tinycloud.opencredentials/m1-denial-credential-manifest/v0");
    const actualFiles = (await readdir("test-fixtures/launch-credential-denials"))
      .filter((file) => file !== "manifest.json" && file !== "PROVENANCE.md")
      .sort();
    expect(actualFiles).toEqual(credentialDenialManifest.files.map((file) => file.path).sort());

    for (const item of credentialDenialManifest.files) {
      const bytes = await Bun.file(`test-fixtures/launch-credential-denials/${item.path}`).arrayBuffer();
      expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(item.sha256);
    }
  });
});

describe("TranscriptRequester external input hardening", () => {
  it("rejects prototype-key SQL lookup, traversal paths, wildcard actions, and invented caveats", async () => {
    const transport = new FixtureTransport([]);
    const catalogClient = await requester(transport);
    await expectRequesterFailure(
      () => catalogClient.readSql("__proto__" as "listen.getConversation"),
      "requester-access-not-contained",
    );
    expect(transport.calls).toHaveLength(0);
    expect(Object.hasOwn(Object.prototype, "name")).toBe(false);

    const client = await requester(new FixtureTransport([challenge(), resolve([kvCapability])]));
    for (const badPath of ["notebooks//x", "notebooks/../x", "notebooks/%2e%2e/x"]) {
      await expectRequesterFailure(() => client.readKv(badPath), "requester-delegation-invalid");
    }

    await expectRequesterFailure(async () => {
      const bad = { ...kvCapability, actions: ["read"] };
      const signed = await requester(new FixtureTransport([challenge(), resolve([bad as unknown as PolicyCapability])]));
      await signed.readKv(kvCapability.path);
    }, "requester-delegation-invalid");

    await expectRequesterFailure(async () => {
      const bad = { ...sqlCapability, caveats: { ...sqlCapability.caveats, clientInvented: true } };
      const signed = await requester(new FixtureTransport([challenge(), resolve([bad as unknown as PolicyCapability])]));
      await signed.readSql("listen.getConversation");
    }, "requester-delegation-invalid");
  });

  it("executes uncaveated SQL grants with exact named catalog reads", async () => {
    const transport = new FixtureTransport([
      challenge(),
      resolve([uncaveatedSqlCapability]),
      { status: 200, body: { rows: [{ id: "conv_456" }] } },
    ]);
    const client = await requester(transport, {
      bootstrap: {
        resourceHint: {
          resourceType: "listen.conversation",
          resourceId: "conv_456",
          requestedCapabilities: [uncaveatedSqlCapability],
        },
      },
    });

    await client.readSql("listen.getConversation");
    expect(transport.calls[2]!.body).toEqual({
      statementName: "listen.getConversation",
      fixedParams: sqlStatement.fixedParams,
    });
  });
});
