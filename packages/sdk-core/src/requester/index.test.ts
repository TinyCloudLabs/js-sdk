import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import {
  HOLDER_KEY_BINDING_PRESENTATION_SCHEMA,
  LISTEN_SQL_STATEMENT_CATALOG,
  POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA,
  POLICY_ENGINE_DENIAL_SCHEMA,
  POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES,
  TranscriptRequesterError,
  createTranscriptRequester,
  deriveDelegationCid,
  listenTranscriptScopedStatementName,
  type RequesterHttpRequest,
  type RequesterHttpResponse,
  type RequesterSigningCapability,
  type RequesterInvocationCapability,
  type RequesterTransport,
} from ".";
import {
  ED25519_JCS_SIGNATURE_SUITE,
  EIP191_JCS_SIGNATURE_SUITE,
  TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
  createAndSignRequesterPolicyEngineRecord,
  jcsCanonicalize,
  policyCapabilityDigestHex,
  type PolicyCapability,
  type SignedObjectSigner,
} from "../policy";

const suitesFixture = (await Bun.file(
  "test-fixtures/policy-engine-vectors/signed-object-profile/signature-suites.json",
).json()) as {
  ed25519: Record<string, { seed_hex: string; did: string }>;
  secp256k1: Record<string, { private_key_hex: string; did: string }>;
};

const listenCatalogFixture = (await Bun.file(
  "test-fixtures/listen-catalog/listen-transcript-sql-statement-catalog.json",
).json()) as { catalog: typeof LISTEN_SQL_STATEMENT_CATALOG };

const wireManifest = (await Bun.file(
  "test-fixtures/policy-engine-wire/manifest.json",
).json()) as {
  cases: Array<{ file: string; name: string; sha256: string }>;
  label: string;
};

const grantOutputVector = (await Bun.file(
  "test-vectors/grant-output-vendored/accept.json",
).json()) as {
  cases: Array<Record<string, any>>;
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
    (await Bun.file(
      `test-fixtures/policy-engine-wire/${item.file}`,
    ).json()) as WireFixture,
  );
}

const denialWireFixtures = new Map<string, DenialWireFixture>();
for (const file of Object.keys(denialWireManifest.fixtures)) {
  denialWireFixtures.set(
    file,
    (await Bun.file(
      `test-fixtures/policy-engine-denial-wire/wire-denials/${file}`,
    ).json()) as DenialWireFixture,
  );
}

const credentialDenialFixtures = new Map<string, CredentialDenialFixture>();
for (const item of credentialDenialManifest.files) {
  if (!item.path.endsWith(".json") || item.path === "manifest.json") {
    continue;
  }
  credentialDenialFixtures.set(
    item.path,
    (await Bun.file(
      `test-fixtures/launch-credential-denials/${item.path}`,
    ).json()) as CredentialDenialFixture,
  );
}

const credentialDenialEntries = [...credentialDenialFixtures.values()].filter(
  (fixture) => fixture.expected === "reject",
);
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
    statements: [
      {
        ...sqlStatement,
        fixedParams: [{ index: 0, value: "conv_456" }],
      },
    ],
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

function eipSigner(name: string): SignedObjectSigner {
  const fixture = suitesFixture.secp256k1[name]!;
  const account = privateKeyToAccount(`0x${fixture.private_key_hex}`);
  return {
    suite: EIP191_JCS_SIGNATURE_SUITE,
    signerDid: fixture.did,
    signDigest: (digest) => account.signMessage({ message: { raw: digest } }),
  };
}

function signingCapability(
  holderDid = REQUESTER_DID,
): RequesterSigningCapability {
  return {
    holderDid,
    keyId: `${holderDid}#device-1`,
    suite: "eddsa-ed25519-sha256-jcs-v1",
    signKeyBinding: (input) =>
      `signed:${input.nonce}:${input.challengeId}:${input.issuedAt}`,
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
    if (request.url.endsWith("/delegate")) {
      const encoded = request.headers?.Authorization;
      const activatedSpace = encoded?.startsWith("ey")
        ? (capabilitiesFromFixtureJws(encoded)[0]?.space ?? OWNER_SPACE_ID)
        : OWNER_SPACE_ID;
      return {
        status: 200,
        body: {
          cid: "bafy-commit-event",
          activated: [activatedSpace],
          skipped: [],
        },
        finalUrl: request.url,
        resolvedAddress: "8.8.8.8",
      };
    }
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected request ${request.url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return { ...next, finalUrl: request.url, resolvedAddress: "8.8.8.8" };
  }

  async resolveEndpoint(): Promise<{ addresses: readonly string[] }> {
    return { addresses: ["8.8.8.8"] };
  }
}

class DelegateReceiptTransport extends FixtureTransport {
  constructor(
    queue: Array<RequesterHttpResponse | Error>,
    private readonly receipt: RequesterHttpResponse,
  ) {
    super(queue);
  }

  override async request(
    request: RequesterHttpRequest,
  ): Promise<RequesterHttpResponse> {
    if (request.url.endsWith("/delegate")) {
      this.calls.push(request);
      return {
        ...this.receipt,
        finalUrl: request.url,
        resolvedAddress: "8.8.8.8",
      };
    }
    return super.request(request);
  }
}

const OWNER_SPACE_ID =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications";
const TRUSTED_OWNER_NODE = {
  endpoint: ENDPOINT,
  spaceId: OWNER_SPACE_ID,
} as const;

function invocationCapability(
  holderDid = REQUESTER_DID,
): RequesterInvocationCapability {
  return {
    holderDid,
    verificationMethod: `${holderDid}#device-1`,
    jwk: { kty: "OKP", crv: "Ed25519", x: "fixture" },
    invoke: (session, service, path, action) => ({
      Authorization: `invoke:${session.delegationCid}:${service}:${path}:${action}`,
    }),
    invokeAny: (session, entries) => ({
      Authorization: `invoke:${session.delegationCid}:${entries.map((entry) => `${entry.service}:${entry.path}:${entry.action}`).join(",")}`,
    }),
  };
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
    eipSigner("owner_root"),
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
    ownerNode: {
      schema: "xyz.tinycloud.exchange/owner-node-endpoint/v1",
      endpoint: ENDPOINT,
      spaceId: OWNER_SPACE_ID,
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
  const presentation = (
    resolveFixture.request.body as { presentation: Record<string, unknown> }
  ).presentation;
  const delegation = (
    resolveFixture.response.body as { delegation: Record<string, unknown> }
  ).delegation;
  const requestedCapabilities = capabilitiesFromFixtureJws(
    delegation.encoded as string,
  );
  const resourceId = requestedCapabilities
    .flatMap((capability) => {
      const caveats = capability.caveats as
        | {
            statements?: readonly {
              fixedParams?: readonly { index?: unknown; value?: unknown }[];
            }[];
          }
        | undefined;
      return caveats?.statements ?? [];
    })
    .flatMap((statement) => statement.fixedParams ?? [])
    .find((param) => param.index === 0)?.value;
  const endpoint = "https://policy-engine.example/v0";
  const record = await createAndSignRequesterPolicyEngineRecord(
    {
      ownerDid: OWNER_DID,
      endpoint,
      audience: presentation.audience as string,
      grantIssuerDid: delegation.issuerDid as string,
      expiresAt: "2026-07-11T00:10:00Z",
    },
    eipSigner("owner_root"),
  );
  return {
    schema: TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
    policyId: delegation.policyId,
    policyEngine: {
      endpoint,
      audience: presentation.audience,
      supportedEvidenceVerifiers: ["w3c.vc/credential/v1"],
      signedRecord: record,
    },
    ownerNode: {
      schema: "xyz.tinycloud.exchange/owner-node-endpoint/v1",
      endpoint,
      spaceId: requestedCapabilities[0]!.space,
    },
    resourceHint: {
      resourceType: "listen.conversation",
      resourceId: typeof resourceId === "string" ? resourceId : "conv_wire",
      requestedCapabilities,
    },
  };
}

async function presentationBootstrap(
  presentation: Record<string, unknown>,
  grantIssuerDid: string,
) {
  const endpoint = "https://policy-engine.example/v0";
  const record = await createAndSignRequesterPolicyEngineRecord(
    {
      ownerDid: OWNER_DID,
      endpoint,
      audience: presentation.audience as string,
      grantIssuerDid,
      expiresAt: "2026-07-11T00:10:00Z",
    },
    eipSigner("owner_root"),
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
    ownerNode: {
      schema: "xyz.tinycloud.exchange/owner-node-endpoint/v1",
      endpoint,
      spaceId: OWNER_SPACE_ID,
    },
    resourceHint: {
      resourceType: "listen.conversation",
      resourceId: "conv_wire",
      requestedCapabilities: presentation.requestedCapabilities,
    },
  };
}

function capabilitiesFromFixtureJws(encoded: string): PolicyCapability[] {
  const payload = JSON.parse(
    Buffer.from(encoded.split(".")[1]!, "base64url").toString("utf8"),
  ) as {
    att: Record<string, Record<string, Array<Record<string, unknown>>>>;
  };
  if (payload.att === undefined) return [];
  return Object.entries(payload.att).flatMap(([resource, abilities]) => {
    const marker = resource.indexOf("/sql/");
    const space = resource.slice(0, marker);
    const path = resource.slice(marker + 5);
    return Object.entries(abilities).map(([action, caveats]) => ({
      service: action.startsWith("tinycloud.sql/")
        ? ("tinycloud.sql" as const)
        : ("tinycloud.kv" as const),
      space,
      path,
      actions: [action],
      ...(Object.keys(caveats[0] ?? {}).length === 0
        ? {}
        : { caveats: caveats[0] }),
    }));
  });
}

function delegationCapabilityHash(
  capabilities: readonly PolicyCapability[],
): string {
  const canonical = [...capabilities].sort((left, right) =>
    `${left.service}\0${left.space}\0${left.path}`.localeCompare(
      `${right.service}\0${right.space}\0${right.path}`,
    ),
  );
  let capabilityHashHex: string;
  try {
    capabilityHashHex =
      capabilities.length === 1
        ? policyCapabilityDigestHex(capabilities[0]!)
        : createHash("sha256")
            .update("xyz.tinycloud.policy/RequestedCapabilities/v0\0")
            .update(jcsCanonicalize(canonical))
            .digest("hex");
  } catch {
    capabilityHashHex = "0".repeat(64);
  }
  return capabilityHashHex;
}

function compactJwsForDelegation(
  capabilities: readonly PolicyCapability[],
  issuanceId: string,
  authority: {
    issuerDid: string;
    holderDid: string;
    policyId: string;
    issuedAt: string;
    expiresAt: string;
    terminal: boolean;
  },
): string {
  const attenuation: Record<string, Record<string, unknown[]>> = {};
  for (const capability of capabilities) {
    const resource = `${OWNER_SPACE_ID}/sql/${capability.path}`;
    const abilities = (attenuation[resource] ??= {});
    for (const action of capability.actions) {
      abilities[action] = [capability.caveats ?? {}];
    }
  }
  const capabilityHashHex = delegationCapabilityHash(capabilities);
  const issuerFragment = authority.issuerDid.startsWith("did:key:")
    ? authority.issuerDid.slice("did:key:".length)
    : "key-1";
  const payload = {
    att: attenuation,
    aud: authority.holderDid,
    exp: Math.floor(Date.parse(authority.expiresAt) / 1000),
    fct: [
      {
        "xyz.tinycloud.policy/capabilityHashHex": capabilityHashHex,
        "xyz.tinycloud.policy/delegationMode": authority.terminal
          ? "terminal"
          : "delegable",
        "xyz.tinycloud.policy/issuanceId": issuanceId,
        "xyz.tinycloud.policy/policyId": authority.policyId,
        "xyz.tinycloud.policy/revocationMode": "refresh_only",
      },
    ],
    iss: `${authority.issuerDid}#${issuerFragment}`,
    nbf: Math.floor(Date.parse(authority.issuedAt) / 1000),
    nnc: issuanceId,
    prf: ["bafy-parent"],
  };
  return [
    Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0" }),
    ).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    Buffer.from("signature").toString("base64url"),
  ].join(".");
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

function delegation(
  capabilities: readonly PolicyCapability[],
  overrides: Record<string, unknown> = {},
) {
  const issuanceId = `iss_test_${++delegationCounter}`;
  const authority = {
    policyId: "pol_test_requester_flow",
    issuerDid: GRANT_ISSUER_DID,
    holderDid: REQUESTER_DID,
    issuedAt: "2026-07-09T12:00:00Z",
    expiresAt: "2026-07-09T12:04:00Z",
    terminal: true,
    ...overrides,
  } as {
    policyId: string;
    issuerDid: string;
    holderDid: string;
    issuedAt: string;
    expiresAt: string;
    terminal: boolean;
    encoded?: string;
  };
  const encoded =
    authority.encoded ??
    compactJwsForDelegation(capabilities, issuanceId, authority);
  return {
    delegationId: deriveDelegationCid(encoded),
    policyId: authority.policyId,
    issuerDid: authority.issuerDid,
    holderDid: authority.holderDid,
    issuanceId,
    capabilityHashHex: delegationCapabilityHash(capabilities),
    revocationMode: "refresh_only",
    issuedAt: authority.issuedAt,
    expiresAt: authority.expiresAt,
    terminal: authority.terminal,
    encoded,
    ...overrides,
  };
}

function resolve(
  capabilities: readonly PolicyCapability[],
  overrides: Record<string, unknown> = {},
) {
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
  const entry = Object.entries(denialWireManifest.fixtures).find(
    ([, fixture]) => fixture.code === code,
  );
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
    .filter(
      (row) =>
        row.layer === "FROZEN-VOCABULARY" &&
        row.reachability !== "mounted-runtime",
    )
    .map((row) => row.code),
);

function expectedStateForMatrixCode(code: string): "denied" | "access-ended" {
  return code === "policy-inactive" || code === "policy-expired"
    ? "access-ended"
    : "denied";
}

async function requester(transport: RequesterTransport, input = {}) {
  return createTranscriptRequester({
    bootstrap: await bootstrap(input),
    requesterDid: REQUESTER_DID,
    ownerDid: OWNER_DID,
    audience: AUDIENCE,
    grantIssuerDid: GRANT_ISSUER_DID,
    trustedOwnerNode: TRUSTED_OWNER_NODE,
    transport,
    signingCapability: signingCapability(),
    invocationCapability: invocationCapability(),
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

describe("TranscriptRequester native bridge conformance", () => {
  it("independently hashes the exact frozen signed-JWS bytes with the node CID framing", () => {
    const vector = grantOutputVector.cases.find(
      (item) => item.case === "deterministic-native-identity-and-ledger-link",
    )!;
    const encoded = vector.issuanceRecord.encoded as string;
    const expectedBytes = Buffer.from(
      vector.expectedDelegationIdBytesHex as string,
      "hex",
    );
    const digest = blake3(new TextEncoder().encode(encoded));

    expect(Buffer.from(digest).equals(expectedBytes.subarray(4))).toBe(true);
    expect(
      Buffer.from(CID.parse(deriveDelegationCid(encoded)).bytes).equals(
        expectedBytes,
      ),
    ).toBe(true);
    expect(deriveDelegationCid(encoded)).toBe(vector.expectedDelegationId);
  });

  it("requires the same holder invocation identity and does not accept presentation signing alone", async () => {
    const queue = [
      challenge(),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [] } },
    ];
    const noInvoke = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport: new FixtureTransport(queue),
      signingCapability: signingCapability(),
      now: () => NOW,
    });
    await expectRequesterFailure(
      () => noInvoke.readSql("listen.getConversation"),
      "requester-invocation-signer-required",
    );

    const mismatch = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport: new FixtureTransport(queue),
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(OWNER_DID),
      now: () => NOW,
    });
    await expectRequesterFailure(
      () => mismatch.readSql("listen.getConversation"),
      "requester-invocation-signer-mismatch",
    );
  });

  it("fails closed before invoke for every non-confirming delegation receipt", async () => {
    const receipts: RequesterHttpResponse[] = [
      { status: 500, body: {} },
      { status: 200, body: { cid: "event", activated: [], skipped: [] } },
      {
        status: 200,
        body: { cid: "event", activated: [], skipped: [OWNER_SPACE_ID] },
      },
      {
        status: 200,
        body: {
          cid: "event",
          activated: [OWNER_SPACE_ID],
          skipped: [OWNER_SPACE_ID],
        },
      },
      { status: 200, body: { activated: [OWNER_SPACE_ID], skipped: [] } },
    ];
    for (const receipt of receipts) {
      const transport = new DelegateReceiptTransport(
        [challenge(), resolve([sqlCapability])],
        receipt,
      );
      const client = await requester(transport);
      await expectRequesterFailure(
        () => client.readSql("listen.getConversation"),
        "requester-delegation-import-failed",
      );
      expect(transport.calls.some((call) => call.url.endsWith("/invoke"))).toBe(
        false,
      );
    }
  });

  it("rejects unsafe endpoints, missing resolution metadata, redirects, and DNS rebinding", async () => {
    await expectRequesterFailure(
      () =>
        requester(new FixtureTransport([]), {
          bootstrap: {
            ownerNode: {
              schema: "xyz.tinycloud.exchange/owner-node-endpoint/v1",
              endpoint: "http://node.example",
              spaceId: OWNER_SPACE_ID,
            },
          },
        }),
      "requester-owner-node-endpoint-invalid",
    );
    await expectRequesterFailure(
      () =>
        requester(new FixtureTransport([]), {
          bootstrap: {
            ownerNode: {
              schema: "xyz.tinycloud.exchange/owner-node-endpoint/v1",
              endpoint: "https://user:secret@node.example",
              spaceId: OWNER_SPACE_ID,
            },
          },
        }),
      "requester-owner-node-endpoint-invalid",
    );
    const missingResolver: RequesterTransport = {
      request: async () => ({ status: 500, body: {} }),
    };
    await expectRequesterFailure(
      () => requester(missingResolver),
      "requester-policy-engine-endpoint-invalid",
    );

    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      const unsafe: RequesterTransport = {
        request: async () => ({ status: 500, body: {} }),
        resolveEndpoint: async () => ({ addresses: [address] }),
      };
      await expectRequesterFailure(
        () => requester(unsafe),
        "requester-policy-engine-endpoint-invalid",
      );
    }

    class RedirectTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/delegate")
          ? { ...response, finalUrl: `${ENDPOINT}/elsewhere` }
          : response;
      }
    }
    const redirected = new RedirectTransport([
      challenge(),
      resolve([sqlCapability]),
    ]);
    await expectRequesterFailure(
      async () =>
        (await requester(redirected)).readSql("listen.getConversation"),
      "requester-owner-node-endpoint-invalid",
    );

    class RebindTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/delegate")
          ? { ...response, resolvedAddress: "1.1.1.1" }
          : response;
      }
    }
    const rebound = new RebindTransport([
      challenge(),
      resolve([sqlCapability]),
    ]);
    await expectRequesterFailure(
      async () => (await requester(rebound)).readSql("listen.getConversation"),
      "requester-owner-node-endpoint-invalid",
    );

    class MissingMetadataTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/delegate")
          ? { status: response.status, body: response.body }
          : response;
      }
    }
    const missingMetadata = new MissingMetadataTransport([
      challenge(),
      resolve([sqlCapability]),
    ]);
    await expectRequesterFailure(
      async () =>
        (await requester(missingMetadata)).readSql("listen.getConversation"),
      "requester-owner-node-endpoint-invalid",
    );

    class EngineRedirectTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/policy/v0/challenge")
          ? { ...response, finalUrl: `${ENDPOINT}/internal-redirect` }
          : response;
      }
    }
    await expectRequesterFailure(
      async () =>
        (await requester(new EngineRedirectTransport([challenge()]))).readSql(
          "listen.getConversation",
        ),
      "requester-policy-engine-endpoint-invalid",
    );

    class EngineRebindTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/policy/v0/challenge")
          ? { ...response, resolvedAddress: "1.1.1.1" }
          : response;
      }
    }
    await expectRequesterFailure(
      async () =>
        (await requester(new EngineRebindTransport([challenge()]))).readSql(
          "listen.getConversation",
        ),
      "requester-policy-engine-endpoint-invalid",
    );

    class EngineMissingMetadataTransport extends FixtureTransport {
      override async request(
        request: RequesterHttpRequest,
      ): Promise<RequesterHttpResponse> {
        const response = await super.request(request);
        return request.url.endsWith("/policy/v0/challenge")
          ? { status: response.status, body: response.body }
          : response;
      }
    }
    await expectRequesterFailure(
      async () =>
        (
          await requester(new EngineMissingMetadataTransport([challenge()]))
        ).readSql("listen.getConversation"),
      "requester-policy-engine-endpoint-invalid",
    );
  });
});

describe("TranscriptRequester bootstrap gate", () => {
  it("does not call /challenge until the signed policy engine record is verified", async () => {
    const transport = new FixtureTransport([
      challenge(),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [] } },
    ]);
    const client = await requester(transport);

    await client.readSql("listen.getConversation");

    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/delegate`,
      `${ENDPOINT}/invoke`,
    ]);
    for (const call of transport.calls) {
      expect(call.redirect).toBe("error");
      expect(call.allowedResolvedAddresses).toEqual(["8.8.8.8"]);
    }
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
          trustedOwnerNode: TRUSTED_OWNER_NODE,
          transport,
          now: () => NOW,
        }),
      "requester-engine-record-signature-invalid",
    );
    await expectRequesterFailure(
      () =>
        requester(transport, {
          record: {
            ownerDid:
              "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          },
        }),
      "requester-engine-record-signature-invalid",
    );
    await expectRequesterFailure(
      () =>
        createTranscriptRequester({
          bootstrap: base,
          requesterDid: REQUESTER_DID,
          ownerDid:
            "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          audience: AUDIENCE,
          grantIssuerDid: GRANT_ISSUER_DID,
          trustedOwnerNode: TRUSTED_OWNER_NODE,
          transport,
          now: () => NOW,
        }),
      "requester-engine-record-owner-mismatch",
    );
    await expectRequesterFailure(
      () => requester(transport, { record: { audience: "wrong-audience" } }),
      "requester-engine-record-audience-mismatch",
    );
    await expectRequesterFailure(
      () =>
        requester(transport, {
          bootstrap: {
            policyEngine: {
              ...base.policyEngine,
              endpoint: "https://evil.example.test",
            },
          },
        }),
      "requester-engine-record-endpoint-mismatch",
    );
    await expectRequesterFailure(
      () =>
        requester(transport, {
          bootstrap: {
            policyEngine: { ...base.policyEngine, audience: "evil-audience" },
          },
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

    expect(await client.readSql("listen.getConversation")).toEqual({
      rows: [{ id: "conv_456" }],
    });
    await expect(
      client.readKv("notebooks/nb_project_notes/docs/alice-note.md"),
    ).resolves.toEqual({ value: "hello" });

    const resolveBody = transport.calls[1]!.body as {
      presentation: {
        schema: string;
        nonce: string;
        holderSignature: { value: string };
      };
    };
    expect(resolveBody.presentation.schema).toBe(
      HOLDER_KEY_BINDING_PRESENTATION_SCHEMA,
    );
    expect(resolveBody.presentation.nonce).toBe("nonce-fresh-0000001");
    expect(resolveBody.presentation.holderSignature.value).toContain(
      "nonce-fresh-0000001",
    );
    const sqlAuthorization = transport.calls[3]!.headers?.Authorization!;
    const kvAuthorization = transport.calls[4]!.headers?.Authorization!;
    expect(sqlAuthorization).toContain(
      ":sql:xyz.tinycloud.listen/conversations:tinycloud.sql/read",
    );
    expect(kvAuthorization).toContain(
      ":kv:notebooks/nb_project_notes/docs/alice-note.md:tinycloud.kv/get",
    );
    expect(sqlAuthorization).not.toContain("write");
    expect(sqlAuthorization.split(":")[1]).toBe(kvAuthorization.split(":")[1]);
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

    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-response-invalid",
    );
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
    ]);
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 2,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [{ renewed: true }],
    });
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/delegate`,
      `${ENDPOINT}/invoke`,
    ]);
    const resolveBodies = transport.calls
      .filter((call) => call.url.endsWith("/resolve"))
      .map(
        (call) =>
          call.body as {
            presentation: { nonce: string; holderSignature: { value: string } };
          },
      );
    expect(resolveBodies.map((body) => body.presentation.nonce)).toEqual([
      "nonce-before-503",
      "nonce-after-0503",
    ]);
    expect(resolveBodies[1]!.presentation.holderSignature.value).toContain(
      "nonce-after-0503",
    );
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
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
      `${ENDPOINT}/delegate`,
      `${ENDPOINT}/invoke`,
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 3,
    });

    const error = await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-unreachable",
    );
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 3,
    });

    const error = await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-unreachable",
    );
    expect(error.state).toBe("unreachable");
    expect(
      transport.calls.filter((call) => call.url.endsWith("/challenge")),
    ).toHaveLength(3);
    expect(
      transport.calls.filter((call) => call.url.endsWith("/resolve")),
    ).toHaveLength(3);
    expect(
      transport.calls
        .filter((call) => call.url.endsWith("/resolve"))
        .map(
          (call) =>
            (call.body as { presentation: { nonce: string } }).presentation
              .nonce,
        ),
    ).toEqual([
      "nonce-timeout-000001",
      "nonce-timeout-000002",
      "nonce-timeout-000003",
    ]);
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
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
    expect(
      (transport.calls[1]!.body as { presentation: { nonce: string } })
        .presentation.nonce,
    ).toBe("nonce-denied-000001");
  });

  it("surfaces typed renewal-required when no permitted signing capability is available", async () => {
    const transport = new FixtureTransport([]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      now: () => NOW,
    });

    const error = await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-renewal-required",
    );
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(OWNER_DID),
      now: () => NOW,
    });

    const error = await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-renewal-required",
    );
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:11Z");
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-challenge-reused",
    );
    expect(
      transport.calls.filter((call) => call.url.endsWith("/resolve")),
    ).toHaveLength(1);
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:41Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [{ renewed: true }],
    });
    expect(transport.calls.map((call) => call.url)).toEqual([
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/delegate`,
      `${ENDPOINT}/invoke`,
      `${ENDPOINT}/policy/v0/challenge`,
      `${ENDPOINT}/policy/v0/resolve`,
      `${ENDPOINT}/delegate`,
      `${ENDPOINT}/invoke`,
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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
      engineRetryAttempts: 2,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [],
    });
    current = new Date("2026-07-09T12:00:10Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [{ renewed: true }],
    });
    expect(
      transport.calls
        .filter((call) => call.url.endsWith("/resolve"))
        .map(
          (call) =>
            (call.body as { presentation: { nonce: string } }).presentation
              .nonce,
        ),
    ).toEqual([
      "nonce-initial-00001",
      "nonce-renewal-0001",
      "nonce-renewal-0002",
    ]);
  });

  it("rechecks the owner-signed engine record expiry before every renewal egress", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-before-record-expiry"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
    });

    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T13:00:00Z");
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-record-invalid",
    );
    expect(transport.calls).toHaveLength(4);
  });
});

describe("TranscriptRequester delegation import and containment", () => {
  it("rejects wider capability, wrong delegation identity, malformed wire bytes, and excessive TTL", async () => {
    await expectRequesterFailure(async () => {
      const client = await requester(
        new FixtureTransport([
          challenge(),
          resolve([
            {
              ...kvCapability,
              path: "notebooks/nb_project_notes/docs/bob-note.md",
            },
          ]),
        ]),
      );
      await client.readKv("notebooks/nb_project_notes/docs/alice-note.md");
    }, "requester-delegation-capability-wider");

    for (const [overrides, code] of [
      [{ holderDid: OWNER_DID }, "requester-delegation-wrong-holder"],
      [{ issuerDid: OWNER_DID }, "requester-delegation-invalid"],
      [{ policyId: "pol_different" }, "requester-delegation-invalid"],
      [{ encoded: "not-a-compact-jws" }, "requester-delegation-invalid"],
      [
        { expiresAt: "2026-07-09T12:05:01Z" },
        "requester-delegation-ttl-excessive",
      ],
    ] as const) {
      await expectRequesterFailure(async () => {
        const client = await requester(
          new FixtureTransport([
            challenge(),
            resolve([sqlCapability], overrides),
          ]),
        );
        await client.readSql("listen.getConversation");
      }, code);
    }
  });

  it("rejects unsigned wrapper metadata that understates signed native authority", async () => {
    const wider = {
      ...kvCapability,
      path: "notebooks/nb_project_notes/docs/bob-note.md",
    };
    const response = resolve([wider], { capabilities: [sqlCapability] });
    const transport = new FixtureTransport([challenge(), response]);
    const client = await requester(transport);
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-response-invalid",
    );
    expect(transport.calls.some((call) => call.url.endsWith("/delegate"))).toBe(
      false,
    );
  });

  it("rejects out-of-capability SQL and KV reads before wire", async () => {
    const sqlOnly = await requester(
      new FixtureTransport([
        challenge(),
        resolve([sqlCapability]),
        { status: 200, body: { rows: [] } },
      ]),
    );
    await sqlOnly.readSql("listen.getConversation");
    await expectRequesterFailure(
      () => sqlOnly.readKv("notebooks/nb_project_notes/docs/alice-note.md"),
      "requester-access-not-contained",
    );

    const kvOnly = await requester(
      new FixtureTransport([
        challenge(),
        resolve([kvCapability]),
        { status: 200, body: { value: "hello" } },
      ]),
    );
    await kvOnly.readKv("notebooks/nb_project_notes/docs/alice-note.md");
    await expectRequesterFailure(
      () => kvOnly.readSql("listen.getConversation"),
      "requester-access-not-contained",
    );
  });

  it("reads each member of a multi-transcript fixed set through a unique catalog statement", async () => {
    const selected = ["conversation-a", "conversation-b"];
    const multiCapability: PolicyCapability = {
      ...sqlCapability,
      caveats: {
        mode: "constrained-statements",
        readOnly: true,
        statements: selected.flatMap((conversationId) =>
          LISTEN_SQL_STATEMENT_CATALOG.map((statement) => ({
            ...statement,
            name: listenTranscriptScopedStatementName(
              statement.name,
              conversationId,
            ),
            fixedParams: [{ index: 0, value: conversationId }],
          })),
        ),
      },
    };
    const transport = new FixtureTransport([
      challenge(),
      resolve([multiCapability]),
      { status: 200, body: { rows: [{ id: "conversation-b" }] } },
    ]);
    const client = await requester(transport, {
      bootstrap: {
        resourceHint: {
          resourceType: "listen.conversation-set",
          resourceId: "listen-share-two",
          requestedCapabilities: [multiCapability],
        },
      },
    });

    await expect(
      client.readSql("listen.getConversation", "conversation-b"),
    ).resolves.toEqual({
      rows: [{ id: "conversation-b" }],
    });
    const invocation = transport.calls.find((call) =>
      call.url.endsWith("/invoke"),
    );
    expect(invocation?.body).toEqual({
      action: "executeStatement",
      name: "listen.getConversation@conversation-b",
      params: [],
    });
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation", "conversation-c"),
      "requester-access-not-contained",
    );
  });

  it("maps server-side denial, unreachable, and policy-inactive renewal distinctly", async () => {
    await expectRequesterFailure(async () => {
      const client = await requester(
        new FixtureTransport([
          challenge(),
          resolve([sqlCapability]),
          denial("capability-not-contained"),
        ]),
      );
      await client.readSql("listen.getConversation");
    }, "requester-node-denied");

    await expectRequesterFailure(async () => {
      const client = await requester(
        new FixtureTransport([
          challenge(),
          resolve([sqlCapability]),
          { status: 503, body: {} },
        ]),
      );
      await client.readSql("listen.getConversation");
    }, "requester-node-unreachable");

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
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });
    await client.readSql("listen.getConversation");
    current = new Date("2026-07-09T12:00:41Z");
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "policy-engine-denied-policy-inactive",
    );
    expect(client.accessState).toBe("access-ended");
    const callsAfterPolicyInactive = transport.calls.length;
    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-access-ended",
    );
    expect(transport.calls).toHaveLength(callsAfterPolicyInactive);
  });
});

describe("TranscriptRequester fixture conformance", () => {
  it("keeps the SDK Listen SQL catalog byte-exact with the vendored catalog", () => {
    expect(LISTEN_SQL_STATEMENT_CATALOG).toEqual(listenCatalogFixture.catalog);
  });

  it("pins refresh semantics to the vendored resolve-happy-native delegation fields", () => {
    const happy = wireFixtures.get("resolve-happy-native")!;
    const delegation = (
      happy.response.body as { delegation: Record<string, unknown> }
    ).delegation;
    expect(Object.keys(delegation).sort()).toEqual([
      "capabilityHashHex",
      "delegationId",
      "encoded",
      "expiresAt",
      "holderDid",
      "issuanceId",
      "issuedAt",
      "issuerDid",
      "policyId",
      "revocationMode",
      "terminal",
    ]);
    expect(delegation.terminal).toBe(true);
    expect(delegation).not.toHaveProperty("refreshOnly");
    expect(delegation).not.toHaveProperty("maxTtlSeconds");
  });

  it("derives renewal timing from signed issuedAt/expiresAt fields", async () => {
    let current = NOW;
    const transport = new FixtureTransport([
      challenge("nonce-terminal-false-old"),
      resolve([sqlCapability], { expiresAt: "2026-07-09T12:00:40Z" }),
      { status: 200, body: { rows: [] } },
      challenge("nonce-terminal-false-new"),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [{ renewed: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap(),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: invocationCapability(),
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [],
    });
    current = new Date("2026-07-09T12:00:11Z");
    await expect(client.readSql("listen.getConversation")).resolves.toEqual({
      rows: [{ renewed: true }],
    });
  });

  it("rejects unvendored resolve response envelopes", async () => {
    const client = await requester(
      new FixtureTransport([
        challenge(),
        {
          status: 200,
          body: { portableDelegation: delegation([sqlCapability]) },
        },
      ]),
    );

    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-engine-response-invalid",
    );
  });

  it("submits the producer-derived node-native resolve bytes exactly and invokes with their local CID", async () => {
    const happy = wireFixtures.get("resolve-happy-native")!;
    const presentation = (
      happy.request.body as { presentation: Record<string, unknown> }
    ).presentation;
    const delegation = (
      happy.response.body as { delegation: Record<string, unknown> }
    ).delegation;
    const nativePresentation = {
      ...presentation,
      policyId: delegation.policyId,
      holderDid: delegation.holderDid,
      eligibleSubjectDid: delegation.holderDid,
      requestedCapabilities: capabilitiesFromFixtureJws(
        delegation.encoded as string,
      ),
    };
    let current = new Date("2026-07-10T12:01:00Z");
    const transport = new FixtureTransport([
      challengeForPresentation(nativePresentation),
      happy.response,
      { status: 200, body: { rows: [{ wire: true }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await wireBootstrap(happy),
      requesterDid: delegation.holderDid as string,
      ownerDid: OWNER_DID,
      audience: presentation.audience as string,
      grantIssuerDid: (
        happy.response.body as { delegation: { issuerDid: string } }
      ).delegation.issuerDid,
      trustedOwnerNode: {
        endpoint: "https://policy-engine.example/v0",
        spaceId: capabilitiesFromFixtureJws(delegation.encoded as string)[0]!
          .space,
      },
      transport,
      signingCapability: {
        holderDid: delegation.holderDid as string,
        keyId: `${delegation.holderDid as string}#fixture`,
        suite: (presentation.holderSignature as { suite: string }).suite,
        holderBinding: presentation.holderBinding,
        eligibleSubjectDid: presentation.eligibleSubjectDid as string,
        signGrantPresentation: () =>
          (presentation.holderSignature as { value: string }).value,
        signKeyBinding: () => {
          throw new Error(
            "signGrantPresentation should be used for fixture conformance",
          );
        },
      },
      invocationCapability: invocationCapability(
        delegation.holderDid as string,
      ),
      holderBinding: presentation.holderBinding,
      eligibleSubjectDid: presentation.eligibleSubjectDid as string,
      presentationTtlSeconds: 90,
      now: () => current,
      sleep: async () => {},
      random: () => 0,
    });

    const nativeResult = await client.readSql("listen.getConversation");
    expect(nativeResult).toEqual({ rows: [{ wire: true }] });
    expect(transport.calls[2]!.headers?.Authorization).toBe(delegation.encoded);
    expect(transport.calls[3]!.headers?.Authorization).toContain(
      delegation.delegationId as string,
    );
    expect(client.accessState).toBe("active");
    current = new Date("2026-07-10T12:04:31Z");
    expect(client.accessState).toBe("needs-renewal");
  });

  it("maps every producer-derived denial fixture to its distinct typed denial", async () => {
    const denialCases = [
      ["challenge-unknown-field", "policy-engine-denied-schema-invalid"],
      ["challenge-unknown-policy", "policy-engine-denied-policy-not-found"],
      [
        "resolve-replay-consumed-nonce",
        "policy-engine-denied-challenge-nonce-consumed",
      ],
      ["resolve-unknown-field", "policy-engine-denied-schema-invalid"],
      [
        "resolve-nonce-substituted-without-resign",
        "policy-engine-denied-holder-signature-invalid",
      ],
      [
        "resolve-requested-capabilities-hash-mismatch",
        "policy-engine-denied-requested-capabilities-hash-mismatch",
      ],
    ] as const;

    for (const [fixtureName, expectedCode] of denialCases) {
      const fixture = wireFixtures.get(fixtureName)!;
      const error = await expectRequesterFailure(async () => {
        if (fixtureName.startsWith("challenge-")) {
          const client = await requester(
            new FixtureTransport([fixture.response]),
          );
          await client.readSql("listen.getConversation");
          return;
        }
        const resolveHappy = wireFixtures.get("resolve-happy-native")!;
        const presentation = (
          resolveHappy.request.body as { presentation: Record<string, unknown> }
        ).presentation;
        const client = await createTranscriptRequester({
          bootstrap: await presentationBootstrap(
            presentation,
            GRANT_ISSUER_DID,
          ),
          requesterDid: presentation.holderDid as string,
          ownerDid: OWNER_DID,
          audience: presentation.audience as string,
          grantIssuerDid: GRANT_ISSUER_DID,
          trustedOwnerNode: {
            endpoint: "https://policy-engine.example/v0",
            spaceId: OWNER_SPACE_ID,
          },
          transport: new FixtureTransport([
            challengeForPresentation(presentation),
            fixture.response,
          ]),
          signingCapability: signingCapability(
            presentation.holderDid as string,
          ),
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
    for (const [file, manifestEntry] of Object.entries(
      denialWireManifest.fixtures,
    )) {
      const matrix = mountedRuntimeMatrixByCode.get(manifestEntry.code);
      expect(
        matrix,
        `${manifestEntry.code} must be mounted-runtime in denial-matrix-v0`,
      ).toBeDefined();
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
        trustedOwnerNode: TRUSTED_OWNER_NODE,
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
    const fixtureCodes = new Set(
      Object.values(denialWireManifest.fixtures).map((fixture) => fixture.code),
    );
    const credentialExpectedCodes = new Set(
      credentialDenialEntries.map(
        (fixture) => fixture.expectedEngineWireCode.code,
      ),
    );

    for (const row of denialMatrix.filter(
      (item) => item.reachability === "mounted-runtime",
    )) {
      expect(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES).toContain(row.code);
      expect(fixtureCodes.has(row.code)).toBe(true);
    }
    for (const frozen of frozenVocabularyNonruntimeCodes) {
      expect(fixtureCodes.has(frozen)).toBe(false);
      expect(credentialExpectedCodes.has(frozen)).toBe(false);
    }
  });

  it("surfaces one credential-evidence representative per expected engine wire code", async () => {
    expect(
      [...credentialRepresentativeFixtureClassByCode.keys()].sort(),
    ).toEqual([
      "enrollment-binding-mismatch",
      "evidence-credential-invalid",
      "evidence-issuer-untrusted",
      "evidence-presentation-invalid",
    ]);

    for (const [
      code,
      fixtureClass,
    ] of credentialRepresentativeFixtureClassByCode) {
      const fixture = credentialDenialEntries.find(
        (item) => item.fixtureClass === fixtureClass,
      );
      expect(
        fixture,
        `${fixtureClass} must exist as the ${code} representative`,
      ).toBeDefined();
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
        trustedOwnerNode: TRUSTED_OWNER_NODE,
        transport,
        signingCapability: signingCapability(),
        evidence:
          fixture!.evidencePresentation === undefined
            ? undefined
            : [fixture!.evidencePresentation],
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
    const manifestInvalidClasses = new Set(
      credentialDenialManifest.fixedInvalidClasses,
    );
    const mappingByClass = new Map<string, string>();
    const classesByCode = new Map<string, Set<string>>();
    const representativeCountsByCode = new Map<string, number>();

    for (const fixture of credentialDenialEntries) {
      expect(
        manifestInvalidClasses.has(fixture.fixtureClass),
        `${fixture.fixtureClass} must be manifest-listed`,
      ).toBe(true);
      expect(
        mappingByClass.has(fixture.fixtureClass),
        `${fixture.fixtureClass} must map once`,
      ).toBe(false);
      const code = fixture.expectedEngineWireCode.code;
      mappingByClass.set(fixture.fixtureClass, code);

      if (
        credentialRepresentativeFixtureClassByCode.get(code) ===
        fixture.fixtureClass
      ) {
        representativeCountsByCode.set(
          code,
          (representativeCountsByCode.get(code) ?? 0) + 1,
        );
      }

      const classes = classesByCode.get(code) ?? new Set<string>();
      classes.add(fixture.fixtureClass);
      classesByCode.set(code, classes);
    }

    expect([...mappingByClass.keys()].sort()).toEqual(
      [...manifestInvalidClasses].sort(),
    );
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
      expect(
        mountedRuntimeMatrixByCode.has(code),
        `${code} must be a mounted-runtime denial code`,
      ).toBe(true);
      expect(
        representativeCountsByCode.get(code),
        `${code} must have exactly one representative case`,
      ).toBe(1);
      expect(
        credentialDenialEntries.filter(
          (fixture) => fixture.expectedEngineWireCode.code === code,
        ),
      ).toHaveLength(classes.size);
    }
    expect(credentialRepresentativeFixtureClassByCode.size).toBe(
      classesByCode.size,
    );
  });

  it("consumes every policy-engine-wire manifest case and pins fixture bytes", async () => {
    expect(wireManifest.label).toBe(
      "confirmed from code: policy-engine service implementation @ 8c4cabbf5",
    );
    const consumed = new Set([
      "challenge-happy",
      "challenge-unknown-field",
      "challenge-unknown-policy",
      "resolve-happy-native",
      "resolve-replay-consumed-nonce",
      "resolve-unknown-field",
      "resolve-nonce-substituted-without-resign",
      "resolve-requested-capabilities-hash-mismatch",
    ]);

    for (const item of wireManifest.cases) {
      expect(consumed.has(item.name)).toBe(true);
      const bytes = await Bun.file(
        `test-fixtures/policy-engine-wire/${item.file}`,
      ).arrayBuffer();
      expect(
        createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
      ).toBe(item.sha256);
    }
  });

  it("pins policy-engine-denial-wire manifest completeness and fixture bytes", async () => {
    expect(denialWireManifest.producerCommit).toBe(
      "8c4cabbf56e51c7e37484c060ffd4a6d51521101",
    );
    const actualFiles = (
      await readdir("test-fixtures/policy-engine-denial-wire/wire-denials")
    )
      .filter((file) => file.endsWith(".json") && file !== "manifest.json")
      .sort();
    expect(actualFiles).toEqual(
      Object.keys(denialWireManifest.fixtures).sort(),
    );

    for (const [file, fixture] of Object.entries(denialWireManifest.fixtures)) {
      const bytes = await Bun.file(
        `test-fixtures/policy-engine-denial-wire/wire-denials/${file}`,
      ).arrayBuffer();
      expect(
        createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
      ).toBe(fixture.sha256);
      expect(
        (denialWireFixtures.get(file)!.body as { error: { code: string } })
          .error.code,
      ).toBe(fixture.code);
    }
  });

  it("pins launch-credential-denials manifest completeness and fixture bytes", async () => {
    expect(credentialDenialManifest.schema).toBe(
      "xyz.tinycloud.opencredentials/m1-denial-credential-manifest/v0",
    );
    const actualFiles = (
      await readdir("test-fixtures/launch-credential-denials")
    )
      .filter((file) => file !== "manifest.json" && file !== "PROVENANCE.md")
      .sort();
    expect(actualFiles).toEqual(
      credentialDenialManifest.files.map((file) => file.path).sort(),
    );

    for (const item of credentialDenialManifest.files) {
      const bytes = await Bun.file(
        `test-fixtures/launch-credential-denials/${item.path}`,
      ).arrayBuffer();
      expect(
        createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
      ).toBe(item.sha256);
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

    const client = await requester(
      new FixtureTransport([challenge(), resolve([kvCapability])]),
    );
    for (const badPath of [
      "notebooks//x",
      "notebooks/../x",
      "notebooks/%2e%2e/x",
    ]) {
      await expectRequesterFailure(
        () => client.readKv(badPath),
        "requester-delegation-invalid",
      );
    }

    await expectRequesterFailure(async () => {
      const bad = { ...kvCapability, actions: ["read"] };
      const signed = await requester(
        new FixtureTransport([
          challenge(),
          resolve([bad as unknown as PolicyCapability]),
        ]),
      );
      await signed.readKv(kvCapability.path);
    }, "requester-delegation-invalid");

    await expectRequesterFailure(async () => {
      const bad = {
        ...sqlCapability,
        caveats: { ...sqlCapability.caveats, clientInvented: true },
      };
      const signed = await requester(
        new FixtureTransport([
          challenge(),
          resolve([bad as unknown as PolicyCapability]),
        ]),
      );
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
    expect(transport.calls[3]!.body).toEqual({
      action: "executeStatement",
      name: "listen.getConversation",
      params: ["conv_456"],
    });
  });

  it("preserves constrained-statement caveats in the native invocation", async () => {
    const invokeCalls: unknown[][] = [];
    const invokeAnyCalls: unknown[][] = [];
    const capability = {
      holderDid: REQUESTER_DID,
      verificationMethod: `${REQUESTER_DID}#device-1`,
      jwk: { kty: "OKP", crv: "Ed25519", x: "fixture", d: "fixture-private" },
      invoke: (...args: unknown[]) => {
        invokeCalls.push(args);
        return { Authorization: "unexpected-singular-invocation" };
      },
      invokeAny: (...args: unknown[]) => {
        invokeAnyCalls.push(args);
        return { Authorization: "caveated-invocation" };
      },
    } as RequesterInvocationCapability & {
      invokeAny: (...args: unknown[]) => { Authorization: string };
    };
    const transport = new FixtureTransport([
      challenge(),
      resolve([sqlCapability]),
      { status: 200, body: { rows: [{ id: "conv_456" }] } },
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap({
        bootstrap: {
          resourceHint: {
            resourceType: "listen.conversation",
            resourceId: "conv_456",
            requestedCapabilities: [sqlCapability],
          },
        },
      }),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: capability,
      now: () => NOW,
    });

    await client.readSql("listen.getConversation");

    expect(invokeCalls).toHaveLength(0);
    expect(invokeAnyCalls).toHaveLength(1);
    expect(invokeAnyCalls[0]?.[1]).toEqual([
      {
        spaceId: OWNER_SPACE_ID,
        service: "sql",
        path: sqlCapability.path,
        action: "tinycloud.sql/read",
        caveats: [sqlCapability.caveats],
      },
    ]);
    expect(transport.calls[3]!.body).toEqual({
      action: "executeStatement",
      name: "listen.getConversation",
      params: [],
    });
  });

  it("rejects a caveated native read before /invoke when the holder signer lacks invokeAny", async () => {
    const { invokeAny: _invokeAny, ...singularOnlyCapability } =
      invocationCapability();
    const transport = new FixtureTransport([
      challenge(),
      resolve([sqlCapability]),
    ]);
    const client = await createTranscriptRequester({
      bootstrap: await bootstrap({
        bootstrap: {
          resourceHint: {
            resourceType: "listen.conversation",
            resourceId: "conv_456",
            requestedCapabilities: [sqlCapability],
          },
        },
      }),
      requesterDid: REQUESTER_DID,
      ownerDid: OWNER_DID,
      audience: AUDIENCE,
      grantIssuerDid: GRANT_ISSUER_DID,
      trustedOwnerNode: TRUSTED_OWNER_NODE,
      transport,
      signingCapability: signingCapability(),
      invocationCapability: singularOnlyCapability,
      now: () => NOW,
    });

    await expectRequesterFailure(
      () => client.readSql("listen.getConversation"),
      "requester-invocation-signer-required",
    );
    expect(transport.calls.some((call) => call.url.endsWith("/invoke"))).toBe(
      false,
    );
  });
});
