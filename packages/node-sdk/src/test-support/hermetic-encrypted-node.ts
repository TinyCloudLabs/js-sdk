import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import {
  canonicalHashHex,
  canonicalizeEncryptionJson,
  canonicalSignedResponse,
  principalDidEquals,
  verifyDidKeyEd25519Signature,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
  type PermissionEntry,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";

import { type ValidatedRuntimeDelegation } from "../delegation";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { TinyCloudNode } from "../TinyCloudNode";

const OWNER_PRIVATE_KEY = "1".padStart(64, "0");
const DELEGATE_PRIVATE_KEY = "2".padStart(64, "0");
const OWNER_CHAIN_ID = 1;
const SECRET_PATH = "vault/secrets/HERMETIC_DELEGATION_CANARY";
const PLAINTEXT = "hermetic encrypted delegation proof";

type CompactPayload = {
  iss?: string;
  att?: Record<string, Record<string, unknown>>;
  prf?: string[];
};

function verifiedCompactPayload(authorization: string): CompactPayload {
  const compact = authorization.replace(/^Bearer /i, "");
  const parts = compact.split(".");
  if (parts.length !== 3) {
    throw new Error("loopback expected a compact UCAN authorization");
  }
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as CompactPayload;
  const issuer = payload.iss?.split("#", 1)[0];
  if (!issuer?.startsWith("did:key:")) throw new Error("loopback expected a did:key invocation issuer");
  if (!verifyDidKeyEd25519Signature(
    issuer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
  )) {
    throw new Error("loopback rejected an invalid UCAN signature");
  }
  return payload;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function didKeyFromPublicKey(publicKey: Uint8Array): string {
  return `did:key:${bases.base58btc.encode(
    concat(Uint8Array.of(0xed, 0x01), publicKey),
  )}`;
}

function hasExactCapability(
  payload: CompactPayload,
  resource: string,
  action: string,
  delegationCid: string,
): boolean {
  return (
    payload.att?.[resource]?.[action] !== undefined &&
    payload.prf?.includes(delegationCid) === true
  );
}

class LoopbackEncryptedNode {
  readonly wasm = new NodeWasmBindings();
  readonly nodePrivateKey = new Uint8Array(32).fill(17);
  readonly nodeId = didKeyFromPublicKey(ed25519.getPublicKey(this.nodePrivateKey));
  readonly networkKeyPair = this.wasm.vault_x25519_from_seed(
    new Uint8Array(32).fill(23),
  );
  readonly activations = new Set<string>();
  readonly rejectedActivationCids = new Set<string>();
  readonly observed = {
    signingIssuers: [] as string[],
    signedDelegation: false,
    signedInvocation: false,
    delegatedKvRead: false,
    delegatedDecrypt: false,
  };

  private readonly server: ReturnType<typeof Bun.serve>;
  private envelope?: InlineEncryptedEnvelope;
  private spaceId?: string;
  private networkId?: string;
  private delegationCid?: string;
  private secretPresent = true;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  get host(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  configure(input: {
    spaceId: string;
    networkId: string;
    delegationCid: string;
    envelope: InlineEncryptedEnvelope;
  }): void {
    this.spaceId = input.spaceId;
    this.networkId = input.networkId;
    this.delegationCid = input.delegationCid;
    this.envelope = input.envelope;
  }

  configureNetwork(spaceId: string, networkId: string): void {
    this.spaceId = spaceId;
    this.networkId = networkId;
  }

  setSecretPresent(value: boolean): void {
    this.secretPresent = value;
  }

  rejectActivation(cid: string): void {
    this.rejectedActivationCids.add(cid);
  }

  stop(): void {
    this.server.stop(true);
  }

  private cidForAuthorization(authorization: string): string {
    const compact = authorization.replace(/^Bearer /i, "");
    return this.wasm.computeCid(new TextEncoder().encode(compact), 0x55n);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private descriptor(): NetworkDescriptor {
    if (!this.networkId) throw new Error("loopback network is not configured");
    return {
      networkId: this.networkId,
      ownerDid: this.networkId.split(":").slice(3, -1).join(":"),
      name: "default",
      members: [{ nodeId: this.nodeId, role: "primary" }],
      threshold: { n: 1, t: 1 },
      state: "active",
      publicEncryptionKey: base64(this.networkKeyPair.publicKey),
      alg: "x25519-aes256gcm/v1",
      keyVersion: 1,
      keyBackend: "local-one-of-one",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
  }

  private assertConfigured(): asserts this is this & {
    envelope: InlineEncryptedEnvelope;
    spaceId: string;
    networkId: string;
    delegationCid: string;
  } {
    if (!this.envelope || !this.spaceId || !this.networkId || !this.delegationCid) {
      throw new Error("loopback encrypted node is not configured");
    }
  }

  private unwrapForNetwork(encryptedSymmetricKey: string): Uint8Array {
    const sealed = fromBase64(encryptedSymmetricKey);
    const ephemeralPublicKey = sealed.slice(0, 32);
    const ciphertext = sealed.slice(32);
    if (ciphertext[0] !== 0x01) {
      throw new Error("loopback expected a node-sdk sealed-box ciphertext");
    }
    const shared = this.wasm.vault_x25519_dh(
      this.networkKeyPair.privateKey,
      ephemeralPublicKey,
    );
    return this.wasm.vault_decrypt(shared, ciphertext.slice(1));
  }

  private wrapForReceiver(
    receiverPublicKey: Uint8Array,
    symmetricKey: Uint8Array,
  ): Uint8Array {
    const ephemeral = this.wasm.vault_x25519_from_seed(this.wasm.vault_random_bytes(32));
    const shared = this.wasm.vault_x25519_dh(
      ephemeral.privateKey,
      receiverPublicKey,
    );
    const ciphertext = this.wasm.vault_encrypt(shared, symmetricKey);
    return concat(ephemeral.publicKey, Uint8Array.of(0x01), ciphertext);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/delegate" && request.method === "POST") {
      const authorization = request.headers.get("authorization");
      if (!authorization) return new Response("missing authorization", { status: 401 });
      const payload = verifiedCompactPayload(authorization);
      if (payload.iss) this.observed.signingIssuers.push(payload.iss);
      const cid = this.cidForAuthorization(authorization);
      if (this.rejectedActivationCids.has(cid)) {
        return new Response("delegation chain rejected by loopback transport", { status: 403 });
      }
      this.observed.signedDelegation = true;
      this.activations.add(cid);
      return this.json({ activated: [cid], skipped: [] });
    }

    const descriptorPrefix = "/encryption/networks/";
    if (
      url.pathname.startsWith(descriptorPrefix) &&
      request.method === "GET" &&
      !url.pathname.endsWith("/decrypt")
    ) {
      if (!this.networkId) return new Response("network not found", { status: 404 });
      return this.json(this.descriptor());
    }

    this.assertConfigured();
    if (url.pathname === "/invoke" && request.method === "POST") {
      const authorization = request.headers.get("authorization");
      if (!authorization) return new Response("missing authorization", { status: 401 });
      const payload = verifiedCompactPayload(authorization);
      if (payload.iss) this.observed.signingIssuers.push(payload.iss);
      const resource = `${this.spaceId}/kv/${SECRET_PATH}`;
      if (
        !hasExactCapability(
          payload,
          resource,
          "tinycloud.kv/get",
          this.delegationCid,
        )
      ) {
        return new Response("delegated kv/get proof required", { status: 403 });
      }
      if (!this.secretPresent) return new Response("not found", { status: 404 });
      this.observed.signedInvocation = true;
      this.observed.delegatedKvRead = true;
      return this.json(this.envelope);
    }

    if (url.pathname.endsWith("/decrypt") && request.method === "POST") {
      const authorization = request.headers.get("authorization");
      if (!authorization) return new Response("missing authorization", { status: 401 });
      const payload = verifiedCompactPayload(authorization);
      if (payload.iss) this.observed.signingIssuers.push(payload.iss);
      const bodyText = await request.text();
      const body = JSON.parse(bodyText) as DecryptRequestBody;
      if (canonicalizeEncryptionJson(body) !== bodyText) {
        return new Response("non-canonical decrypt body", { status: 400 });
      }
      if (
        body.networkId !== this.networkId ||
        !hasExactCapability(
          payload,
          this.networkId,
          "tinycloud.encryption/decrypt",
          this.delegationCid,
        )
      ) {
        return new Response("delegated decrypt proof required", { status: 403 });
      }
      const expectedWrappedKeyHash = canonicalHashHex(
        (bytes) => this.wasm.vault_sha256(bytes),
        body.encryptedSymmetricKey,
      );
      if (body.encryptedSymmetricKeyHash !== expectedWrappedKeyHash) {
        return new Response("encrypted key hash mismatch", { status: 400 });
      }

      const symmetricKey = this.unwrapForNetwork(body.encryptedSymmetricKey);
      const wrappedKey = this.wrapForReceiver(
        fromBase64(body.receiverPublicKey),
        symmetricKey,
      );
      const invocationCid = this.cidForAuthorization(authorization);
      const requestHash = Buffer.from(
        this.wasm.vault_sha256(
          new TextEncoder().encode(`${invocationCid}${canonicalHashHex(
            (bytes) => this.wasm.vault_sha256(bytes),
            body,
          )}`),
        ),
      ).toString("hex");
      const response: DecryptResponseBody = {
        type: "tinycloud.encryption.decrypt-result/v1",
        targetNode: this.nodeId,
        networkId: body.networkId,
        invocationCid,
        encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
        receiverPublicKeyHash: body.receiverPublicKeyHash,
        wrappedKey: base64(wrappedKey),
        alg: body.alg,
        keyVersion: body.keyVersion,
        requestHash,
        nodeId: this.nodeId,
        nodeSignature: "",
      };
      response.nodeSignature = base64(
        ed25519.sign(
          new TextEncoder().encode(canonicalSignedResponse(response)),
          this.nodePrivateKey,
        ),
      );
      this.observed.delegatedDecrypt = true;
      return this.json(response);
    }

    return new Response("not found", { status: 404 });
  }
}

function makeNode(host: string, privateKey: string, wasmBindings: NodeWasmBindings): {
  node: TinyCloudNode;
  signer: PrivateKeySigner;
} {
  const signer = new PrivateKeySigner(privateKey, OWNER_CHAIN_ID);
  return {
    signer,
    node: new TinyCloudNode({ host, signer, wasmBindings }),
  };
}

async function makeSession(
  node: TinyCloudNode,
  signer: PrivateKeySigner,
  input: {
    address: string;
    spaceId: string;
    abilities: Record<string, Record<string, string[]>>;
    rawAbilities?: Record<string, string[]>;
  },
): Promise<TinyCloudSession> {
  const wasm = (node as unknown as { wasmBindings: NodeWasmBindings }).wasmBindings;
  const jwk = (node as unknown as { sessionKeyJwk: object }).sessionKeyJwk;
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities: input.abilities,
    ...(input.rawAbilities ? { rawAbilities: input.rawAbilities } : {}),
    address: wasm.ensureEip55(input.address),
    chainId: OWNER_CHAIN_ID,
    domain: "127.0.0.1",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60 * 60_000).toISOString(),
    spaceId: input.spaceId,
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    address: input.address,
    chainId: OWNER_CHAIN_ID,
    sessionKey: "default",
    spaceId: input.spaceId,
    delegationCid: session.delegationCid,
    delegationHeader: session.delegationHeader,
    verificationMethod: node.sessionDid,
    jwk: jwk as TinyCloudSession["jwk"],
    siwe: prepared.siwe,
    signature,
  };
}

function installSession(node: TinyCloudNode, session: TinyCloudSession): void {
  const internals = node as unknown as {
    auth: { setRestoredTinyCloudSession(session: TinyCloudSession, hosts: string[]): void };
    _address: string;
    _chainId: number;
    initializeServices(): void;
  };
  internals.auth.setRestoredTinyCloudSession(session, [node.hosts[0]!]);
  internals._address = session.address;
  internals._chainId = session.chainId;
  internals.initializeServices();
}

export interface HermeticEncryptedNode {
  readonly host: string;
  readonly delegate: TinyCloudNode;
  readonly restorableSession: {
    delegationHeader: { Authorization: string };
    delegationCid: string;
    spaceId: string;
    jwk: object;
    verificationMethod: string;
    address: string;
    chainId: number;
    siwe: string;
    signature: string;
    tinycloudHosts: string[];
  };
  readonly permissions: readonly PermissionEntry[];
  readonly unrelatedAudience: string;
  createRestoredDelegate(): TinyCloudNode;
  mintDelegation(): Promise<Awaited<ReturnType<TinyCloudNode["delegateTo"]>>["delegation"]>;
  mintDelegationWithPermissions(
    permissions: PermissionEntry[],
  ): Promise<Awaited<ReturnType<TinyCloudNode["delegateTo"]>>["delegation"]>;
  mintDelegationForAudience(
    audience: string,
  ): Promise<Awaited<ReturnType<TinyCloudNode["delegateTo"]>>["delegation"]>;
  mintUntrustedDelegation(): Promise<Awaited<ReturnType<TinyCloudNode["delegateTo"]>>["delegation"]>;
  readAndDecrypt(node: TinyCloudNode, delegation: ValidatedRuntimeDelegation): Promise<void>;
  assertNarrowDelegatedReadAndDecrypt(
    delegation: ValidatedRuntimeDelegation,
    expectedSigningIssuer?: string,
  ): void;
  stop(): void;
}

/**
 * Build a loopback encrypted-node fixture for delegation tests.
 *
 * The owner and delegate use real NodeWasmBindings to create base sessions,
 * mint the compact UCAN, CID-bind it, install it, and sign KV/decrypt
 * invocations. The HTTP server is deliberately minimal: it validates the
 * received invocation shape/proof and performs real X25519 + authenticated
 * symmetric encryption through the same WASM crypto methods. It emulates only
 * host-side UCAN chain/revocation storage and request authorization.
 */
export async function createHermeticEncryptedNode(
  options: Readonly<{
    delegateBasePermissions?: boolean;
    secretPayloadValue?: string;
    secretPresent?: boolean;
  }> = {},
): Promise<HermeticEncryptedNode> {
  const transport = new LoopbackEncryptedNode();
  const ownerRuntime = makeNode(transport.host, OWNER_PRIVATE_KEY, transport.wasm);
  const delegateRuntime = makeNode(transport.host, DELEGATE_PRIVATE_KEY, transport.wasm);
  const ownerAddress = await ownerRuntime.signer.getAddress();
  const spaceId = transport.wasm.makeSpaceId(ownerAddress, OWNER_CHAIN_ID, "secrets");
  const ownerDid = `did:pkh:eip155:${OWNER_CHAIN_ID}:${transport.wasm.ensureEip55(ownerAddress)}`;
  const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;
  const permissions: PermissionEntry[] = [
    {
      service: "tinycloud.encryption",
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
    },
    {
      service: "tinycloud.kv",
      space: spaceId,
      path: SECRET_PATH,
      actions: ["tinycloud.kv/get"],
    },
  ];
  transport.configureNetwork(spaceId, networkId);
  transport.setSecretPresent(options.secretPresent ?? true);

  const ownerSession = await makeSession(ownerRuntime.node, ownerRuntime.signer, {
    address: ownerAddress,
    spaceId,
    abilities: { kv: { [SECRET_PATH]: ["tinycloud.kv/get"] } },
    rawAbilities: { [networkId]: ["tinycloud.encryption/decrypt"] },
  });
  installSession(ownerRuntime.node, ownerSession);

  const delegateAddress = await delegateRuntime.signer.getAddress();
  const delegateSession = await makeSession(delegateRuntime.node, delegateRuntime.signer, {
    address: delegateAddress,
    spaceId,
    abilities: options.delegateBasePermissions
      ? { kv: { [SECRET_PATH]: ["tinycloud.kv/get"] } }
      : {},
    ...(options.delegateBasePermissions
      ? { rawAbilities: { [networkId]: ["tinycloud.encryption/decrypt"] } }
      : {}),
  });
  installSession(delegateRuntime.node, delegateSession);

  const descriptor: NetworkDescriptor = {
    networkId,
    ownerDid,
    name: "default",
    members: [{ nodeId: transport.nodeId, role: "primary" }],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: base64(transport.networkKeyPair.publicKey),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
  const encrypted = await delegateRuntime.node.encryption.encryptToNetwork(
    networkId,
    new TextEncoder().encode(options.secretPayloadValue === undefined
      ? PLAINTEXT
      : JSON.stringify({
        value: options.secretPayloadValue,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      })),
    { descriptor },
  );
  if (!encrypted.ok) {
    transport.stop();
    throw new Error(`failed to prepare encrypted fixture: ${encrypted.error.message}`);
  }

  const mint = async (audience: string) => {
    const minted = await ownerRuntime.node.delegateTo(audience, permissions);
    transport.configure({
      spaceId,
      networkId,
      delegationCid: minted.delegation.cid,
      envelope: encrypted.data,
    });
    return minted.delegation;
  };

  const unrelatedManager = transport.wasm.createSessionManager();
  const unrelatedAudience = unrelatedManager
    .getDID(unrelatedManager.createSessionKey("unrelated"))
    .split("#", 1)[0]!;
  const delegateAudience = delegateRuntime.node.sessionDid.split("#", 1)[0]!;

  return {
    host: transport.host,
    delegate: delegateRuntime.node,
    restorableSession: {
      delegationHeader: delegateSession.delegationHeader,
      delegationCid: delegateSession.delegationCid,
      spaceId: delegateSession.spaceId,
      jwk: delegateSession.jwk,
      verificationMethod: delegateSession.verificationMethod,
      address: delegateSession.address,
      chainId: delegateSession.chainId,
      siwe: delegateSession.siwe,
      signature: delegateSession.signature,
      tinycloudHosts: [transport.host],
    },
    permissions,
    unrelatedAudience,
    createRestoredDelegate: () =>
      new TinyCloudNode({ host: transport.host, wasmBindings: transport.wasm }),
    mintDelegation: () => mint(delegateAudience),
    mintDelegationWithPermissions: (requestedPermissions) =>
      ownerRuntime.node.delegateTo(delegateAudience, requestedPermissions).then(({ delegation }) => {
        transport.configure({
          spaceId,
          networkId,
          delegationCid: delegation.cid,
          envelope: encrypted.data,
        });
        return delegation;
      }),
    mintDelegationForAudience: mint,
    async mintUntrustedDelegation() {
      const delegation = await mint(delegateAudience);
      transport.rejectActivation(delegation.cid);
      return delegation;
    },
    async readAndDecrypt(node, delegation) {
      const read = await node.kv.get<InlineEncryptedEnvelope>(SECRET_PATH);
      if (!read.ok || !read.data.data) {
        throw new Error("loopback delegated KV read failed");
      }
      const decrypted = await node.encryption.decryptEnvelope(
        read.data.data,
        { proofs: [delegation.cid] },
      );
      if (!decrypted.ok || new TextDecoder().decode(decrypted.data) !== PLAINTEXT) {
        throw new Error("loopback delegated decrypt failed");
      }
    },
    assertNarrowDelegatedReadAndDecrypt(delegation, expectedSigningIssuer) {
      if (!transport.observed.signedDelegation || !transport.observed.signedInvocation ||
        !transport.observed.delegatedKvRead || !transport.observed.delegatedDecrypt) {
        throw new Error("loopback did not validate signed delegation and invocation traffic");
      }
      if (!transport.activations.has(delegation.cid)) {
        throw new Error("loopback did not observe the validated delegation activation");
      }
      if (expectedSigningIssuer && !transport.observed.signingIssuers.some((issuer) =>
        principalDidEquals(issuer, expectedSigningIssuer)
      )) {
        throw new Error("loopback did not observe a signature from the expected restored session key");
      }
    },
    stop: () => transport.stop(),
  };
}
