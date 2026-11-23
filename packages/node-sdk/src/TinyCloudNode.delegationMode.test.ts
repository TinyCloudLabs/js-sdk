import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import {
  DELEGATION_MODE_KEY,
  TERMINAL_REDELEGATION_REFUSED_MESSAGE,
  extractRecapAttenuations,
  extractSiweDelegationMode,
  ownerFullAccess,
  parseCanonicalRecapResource,
  parseSignedSiweCacao,
  withSiweDelegationMode,
} from "@tinycloud/sdk-core";
import { decodeBase64Url } from "../../sdk-core/src/credentials/digest";
import { decodeCanonicalDagCbor } from "../../sdk-core/src/delegations/cacao";
import { parseDelegationModeField } from "../../sdk-core/src/delegations/terminal";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { wireOpenKeyAuthorize } from "./authorization/openKeyBridge";
import {
  startUnregisteredLocationRegistry,
  type UnregisteredLocationRegistry,
} from "./test-support/unregistered-location-registry";

const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const ownerAccount = privateKeyToAccount(`0x${OWNER_KEY}`);
let registry: UnregisteredLocationRegistry;

beforeAll(() => {
  registry = startUnregisteredLocationRegistry();
});

afterAll(() => {
  registry?.stop(true);
});

function makeSignedOpenKeyResult(siwe: string, signature: string) {
  const caps = extractRecapAttenuations(siwe);
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actionsMap] of Object.entries(caps)) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const byService = new Map<string, string[]>();
    for (const action of Object.keys(actionsMap)) {
      const service = action.slice(0, action.indexOf("/"));
      selectedActionKeys.push(`${service}\0${space}\0${path}\0${action}`);
      const list = byService.get(service) ?? [];
      list.push(action);
      byService.set(service, list);
    }
    for (const [service, actions] of byService) {
      permissions.push({ service, space, path, actions });
    }
  }
  return {
    protocolVersion: 1 as const,
    address: ownerAccount.address,
    signature,
    signedMessage: siwe,
    selectedActionKeys,
    permissions,
  };
}

function makeFakeFetch(overrides: { delegateStatus?: number; delegateBody?: string } = {}) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    const auth = headers?.Authorization ?? headers?.authorization;
    calls.push({ url, method, auth });
    if (url.startsWith(registry.url.origin)) {
      return originalFetch(input, init);
    }
    if (url.endsWith("/delegate")) {
      const status = overrides.delegateStatus ?? 200;
      const body = overrides.delegateBody ?? JSON.stringify({ activated: [], skipped: [] });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/version") || url.endsWith("/info") || url.includes("/capabilities")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.26.22", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/peer-id") || url.includes("/host")) {
      return new Response(JSON.stringify({ peerId: "12D3KooWTestPeerId" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    install() { globalThis.fetch = mockFetch; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

describe("TC-3810 SDK delegationMode minting sites and OpenKey verification", () => {
  test("normal owner signIn declares attenuable in SIWE and CACAO", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const node = new TinyCloudNode({
        host: "http://127.0.0.1:9999",
        tinycloudRegistryUrl: registry.url.origin,
        signer: new PrivateKeySigner(OWNER_KEY),
        wasmBindings: new NodeWasmBindings(),
        domain: "app.test",
        autoCreateSpace: false,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
        ...ownerFullAccess(),
      });
      await node.signIn();
      const session = node.restorableSession!;
      expect(extractSiweDelegationMode(session.siwe!)).toBe("attenuable");
      const cacao = await parseSignedSiweCacao(session.delegationHeader.Authorization, session.delegationCid);
      expect(cacao.delegationMode).toBe("attenuable");
    } finally {
      net.restore();
    }
  });

  test("grantRuntimePermissions declares attenuable on the owner session-key grant", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const node = new TinyCloudNode({
        host: "http://127.0.0.1:9999",
        tinycloudRegistryUrl: registry.url.origin,
        signer: new PrivateKeySigner(OWNER_KEY),
        wasmBindings: new NodeWasmBindings(),
        domain: "app.test",
        autoCreateSpace: false,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
      });
      await node.signIn();
      const grants = await node.grantRuntimePermissions([
        { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get"] },
      ]);
      expect(grants).toHaveLength(1);
      expect(extractSiweDelegationMode(grants[0]!.siweProof!.siwe)).toBe("attenuable");
      const cacao = await parseSignedSiweCacao(grants[0]!.delegationHeader.Authorization, grants[0]!.cid);
      expect(cacao.delegationMode).toBe("attenuable");
    } finally {
      net.restore();
    }
  });

  test("createDelegationWalletPath mints terminal for main and public-space companion CACAOs and accepts disableSubDelegation", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const node = new TinyCloudNode({
        host: "http://127.0.0.1:9999",
        tinycloudRegistryUrl: registry.url.origin,
        signer: new PrivateKeySigner(OWNER_KEY),
        wasmBindings: new NodeWasmBindings(),
        domain: "app.test",
        autoCreateSpace: false,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
        ...ownerFullAccess(),
      });
      await node.signIn();
      const recipient = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      const result = await node.delegateTo(
        recipient,
        [{ service: "tinycloud.kv", space: "default", path: "shared/", actions: ["tinycloud.kv/get"] }],
        { forceWalletSign: true, disableSubDelegation: true },
      );
      expect(result.prompted).toBe(true);
      expect(result.delegation.disableSubDelegation).toBe(true);
      const readCacaoRecapMode = (authorization: string) => {
        const cacao = decodeCanonicalDagCbor(decodeBase64Url(authorization.replace(/=+$/, ""))) as {
          p: { resources?: string[] };
        };
        const recap = cacao.p.resources?.at(-1);
        expect(recap?.startsWith("urn:recap:")).toBe(true);
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(recap!.slice("urn:recap:".length))),
        ) as Record<string, unknown>;
        return parseDelegationModeField(parsed);
      };
      expect(readCacaoRecapMode(result.delegation.delegationHeader.Authorization)).toBe("terminal");

      expect(result.delegation.publicDelegation).toBeDefined();
      expect(result.delegation.publicDelegation!.disableSubDelegation).toBe(true);
      expect(readCacaoRecapMode(result.delegation.publicDelegation!.delegationHeader.Authorization)).toBe("terminal");
    } finally {
      net.restore();
    }
  });

  test("excluded createOwnerDelegation (D2 share grants) leaves delegationMode absent", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const node = new TinyCloudNode({
        host: "http://127.0.0.1:9999",
        tinycloudRegistryUrl: registry.url.origin,
        signer: new PrivateKeySigner(OWNER_KEY),
        wasmBindings: new NodeWasmBindings(),
        domain: "app.test",
        autoCreateSpace: false,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
        ...ownerFullAccess(),
      });
      await node.signIn();
      const receipt = await node.createOwnerDelegation({
        delegateDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        spaceId: node.restorableSession!.spaceId,
        expiresAt: new Date(Date.now() + 3600_000),
        permissions: [{ service: "tinycloud.kv", path: "share/doc", actions: ["tinycloud.kv/get"] }],
      });
      const cacao = await parseSignedSiweCacao(receipt.delegation.authHeader!, receipt.delegationCid);
      expect(cacao.delegationMode).toBeUndefined();
      expect("delegationMode" in cacao).toBe(false);
    } finally {
      net.restore();
    }
  });

  test("OpenKey signInWithOpenKey declares attenuable, forwards delegationMode, accepts unchanged/narrowed/expiry-edited mode, and refuses dropped or flipped mode", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const wasm = new NodeWasmBindings();
      const makeAuth = () =>
        new NodeUserAuthorization({
          tinycloudRegistryUrl: registry.url.origin,
          signer: new PrivateKeySigner(OWNER_KEY),
          wasmBindings: wasm,
          domain: "app.test",
          tinycloudHosts: ["http://127.0.0.1:9999"],
          autoCreateSpace: false,
          enablePublicSpace: false,
          defaultActions: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] } },
        });

      // 1. wireOpenKeyAuthorize forwards delegationMode: "attenuable" and unchanged round-trip succeeds.
      let forwardedRequest: Record<string, unknown> | undefined;
      const auth1 = makeAuth();
      const bridge = wireOpenKeyAuthorize({
        async authorizeTinyCloud(req) {
          forwardedRequest = req as unknown as Record<string, unknown>;
          const sig = await ownerAccount.signMessage({ message: req.siwe });
          return makeSignedOpenKeyResult(req.siwe, sig);
        },
      });
      const session1 = await auth1.signInWithOpenKey(bridge);
      expect(forwardedRequest?.delegationMode).toBe("attenuable");
      expect(extractSiweDelegationMode(String(forwardedRequest?.siwe))).toBe("attenuable");
      expect(extractSiweDelegationMode(session1.siwe!)).toBe("attenuable");

      // 2. Narrowed scope + changed expiry preserving "attenuable" succeeds.
      const auth2 = makeAuth();
      const pending2 = await auth2.prepareOpenKeySignIn({ expiryChangeable: true });
      const origParsed = new SiweMessage(pending2.request.siwe);
      const origCaps = extractRecapAttenuations(pending2.request.siwe);
      const kvResource = Object.keys(origCaps).find((r) => r.startsWith(`${pending2.prepared.spaceId}/kv`))!;
      const narrowedRecap = {
        att: { [kvResource]: { "tinycloud.kv/get": [{}] } },
        prf: [],
        [DELEGATION_MODE_KEY]: "attenuable",
      };
      const narrowedSiwe = new SiweMessage({
        domain: origParsed.domain,
        address: origParsed.address,
        statement: `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.kv': 'get' for '${kvResource}'.`,
        uri: origParsed.uri,
        version: origParsed.version,
        chainId: origParsed.chainId,
        nonce: origParsed.nonce,
        issuedAt: origParsed.issuedAt,
        expirationTime: new Date(Date.now() + 1800_000).toISOString(),
        resources: [`urn:recap:${Buffer.from(JSON.stringify(narrowedRecap)).toString("base64url")}`],
      }).prepareMessage();
      const sig2 = await ownerAccount.signMessage({ message: narrowedSiwe });
      const session2 = await auth2.signInWithOpenKeyResult(
        makeSignedOpenKeyResult(narrowedSiwe, sig2),
        pending2.prepared,
        pending2.keyId,
        pending2.jwk,
        { expiryChangeable: true },
      );
      expect(extractSiweDelegationMode(session2.siwe!)).toBe("attenuable");

      // 3. Flipped mode (attenuable -> terminal) is refused.
      const auth3 = makeAuth();
      const pending3 = await auth3.prepareOpenKeySignIn();
      const flippedSiwe = withSiweDelegationMode(pending3.request.siwe, "terminal");
      const sig3 = await ownerAccount.signMessage({ message: flippedSiwe });
      await expect(
        auth3.signInWithOpenKeyResult(
          makeSignedOpenKeyResult(flippedSiwe, sig3),
          pending3.prepared,
          pending3.keyId,
          pending3.jwk,
        ),
      ).rejects.toThrow(/delegation mode/i);

      // 4. Absent mode returned for an attenuable request stays accepted as legacy-attenuable (pre-#735 OpenKey).
      const auth4 = makeAuth();
      const pending4 = await auth4.prepareOpenKeySignIn();
      const recapMatch = pending4.request.siwe.match(/- urn:recap:([A-Za-z0-9_-]+)$/)!;
      const decoded4 = JSON.parse(Buffer.from(recapMatch[1]!, "base64url").toString("utf8"));
      delete decoded4[DELEGATION_MODE_KEY];
      const absentSiwe =
        pending4.request.siwe.slice(0, -recapMatch[0].length) +
        `- urn:recap:${Buffer.from(JSON.stringify(decoded4)).toString("base64url")}`;
      const sig4 = await ownerAccount.signMessage({ message: absentSiwe });
      const session4 = await auth4.signInWithOpenKeyResult(
        makeSignedOpenKeyResult(absentSiwe, sig4),
        pending4.prepared,
        pending4.keyId,
        pending4.jwk,
      );
      expect(extractSiweDelegationMode(session4.siwe!)).toBeUndefined();

      // 5. Dropping a declared terminal mode to absent OR flipping terminal -> attenuable is refused.
      const auth5 = makeAuth();
      const pending5 = await auth5.prepareOpenKeySignIn();
      const terminalPrepared = {
        ...pending5.prepared,
        siwe: withSiweDelegationMode(pending5.prepared.siwe, "terminal"),
      };
      const recapMatch5 = pending5.request.siwe.match(/- urn:recap:([A-Za-z0-9_-]+)$/)!;
      const decoded5 = JSON.parse(Buffer.from(recapMatch5[1]!, "base64url").toString("utf8"));
      delete decoded5[DELEGATION_MODE_KEY];
      const droppedTerminalSiwe =
        pending5.request.siwe.slice(0, -recapMatch5[0].length) +
        `- urn:recap:${Buffer.from(JSON.stringify(decoded5)).toString("base64url")}`;
      const sig5Dropped = await ownerAccount.signMessage({ message: droppedTerminalSiwe });
      await expect(
        auth5.signInWithOpenKeyResult(
          makeSignedOpenKeyResult(droppedTerminalSiwe, sig5Dropped),
          terminalPrepared,
          pending5.keyId,
          pending5.jwk,
        ),
      ).rejects.toThrow(/delegation mode/i);

      const sig5Flipped = await ownerAccount.signMessage({ message: pending5.request.siwe });
      await expect(
        auth5.signInWithOpenKeyResult(
          makeSignedOpenKeyResult(pending5.request.siwe, sig5Flipped),
          terminalPrepared,
          pending5.keyId,
          pending5.jwk,
        ),
      ).rejects.toThrow(/delegation mode/i);
    } finally {
      net.restore();
    }
  });

  test("wallet-mode useDelegation maps node 401 terminal-parent-cannot-redelegate to Monica's refusal message", async () => {
    const net = makeFakeFetch();
    net.install();
    try {
      const node = new TinyCloudNode({
        host: "http://127.0.0.1:9999",
        tinycloudRegistryUrl: registry.url.origin,
        signer: new PrivateKeySigner(OWNER_KEY),
        wasmBindings: new NodeWasmBindings(),
        domain: "app.test",
        autoCreateSpace: false,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
        ...ownerFullAccess(),
      });
      await node.signIn();
      net.restore();

      const refuseNet = makeFakeFetch({
        delegateStatus: 401,
        delegateBody: "terminal-parent-cannot-redelegate",
      });
      refuseNet.install();
      try {
        const err = await node
          .useDelegation({
            cid: "bafkr4ibsw5yjl7ffzhpn53mf6h53yc7mozvvpifsg2jw7r4pzivjnrlrpa",
            delegationHeader: { Authorization: "fake" },
            spaceId: node.restorableSession!.spaceId,
            path: "shared/",
            actions: ["tinycloud.kv/get"],
            disableSubDelegation: true,
            expiry: new Date(Date.now() + 3600_000),
            delegateDID: `did:pkh:eip155:1:${ownerAccount.address}`,
            ownerAddress: ownerAccount.address,
            chainId: 1,
            host: "http://127.0.0.1:9999",
          })
          .catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe(TERMINAL_REDELEGATION_REFUSED_MESSAGE);
        expect(err.code).toBe("TERMINAL_PARENT_CANNOT_REDELEGATE");
      } finally {
        refuseNet.restore();
      }
    } finally {
      net.restore();
    }
  });
});
