import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
// The web SDK's own WASM bindings. The package entry point needs a DOM, so
// import the adapter source: it is exactly what a browser TinyCloudWeb hands
// to its inner TinyCloudNode, and the vault service above it is the same code.
import { BrowserWasmBindings } from "../../packages/web-sdk/src/adapters/BrowserWasmBindings";
import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * Live tests (real local node) for the vault CAS and AAD primitives TC-1432
 * slice 1 adds: `VaultEntry.etag`, `VaultPutOptions.ifMatch` and the opt-in
 * `VaultGetOptions.expectAad`.
 *
 * Needs `TC_TEST_SERVER` (a local tinycloud-node; never production).
 */

const BLAKE3_ETAG = /^"blake3-[0-9a-f]{64}"$/;
const RUN = `${Date.now()}`;
const key = (name: string) => `cas-aad-live/${RUN}/${name}`;
const enc = (text: string) => new TextEncoder().encode(text);

const ownerKey = Wallet.createRandom().privateKey.slice(2);

function makeClient(webWasm: boolean): TinyCloudNode {
  return new TinyCloudNode({
    host: SERVER_URL,
    signer: new PrivateKeySigner(ownerKey),
    ...(webWasm ? { wasmBindings: new BrowserWasmBindings() } : {}),
    domain: "vault-cas-aad.test",
    autoBootstrapAccount: false,
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoCreateSpace: true,
  });
}

type Json = Record<string, unknown>;

async function must<T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
): Promise<T> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe("vault etag / ifMatch / expectAad (live node)", () => {
  // `node` runs the node WASM; `web` is the same owner on the web SDK's WASM.
  let node: TinyCloudNode;
  let web: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    node = makeClient(false);
    await node.signIn();
    await node.ensureEncryptionNetwork(node.getDefaultEncryptionNetworkId());
    // Hosting the secrets space is idempotent (a scoped session does not auto-host it).
    await node.ensureOwnedSpaceHosted("secrets");
    web = makeClient(true);
    await web.signIn();
  }, 60_000);

  async function readEtag(client: TinyCloudNode, name: string): Promise<string> {
    const entry = await must(await client.vault.get<Json>(key(name), { source: "network" }));
    if (entry.etag === undefined) throw new Error("no etag");
    return entry.etag;
  }

  /** Write an envelope with an arbitrary AAD (or none) straight into KV. */
  async function putRawEnvelope(name: string, value: Json, aad?: string): Promise<void> {
    const envelope = await must(
      await node.encryption.encryptToNetwork(
        node.getDefaultEncryptionNetworkId(),
        enc(JSON.stringify(value)),
        {
          ...(aad === undefined ? {} : { aad: enc(aad) }),
          metadata: {
            "x-vault-version": "2",
            "x-vault-cipher": "tinycloud-network-envelope",
            "x-vault-content-type": "application/json",
          },
        },
      ),
    );
    await must(await node.kv.put(`vault/${key(name)}`, JSON.stringify(envelope)));
  }

  describe("etag", () => {
    test("a network read returns the node's strong etag; a default read does not", async () => {
      await must(await node.vault.put(key("etag"), { n: 1 }));
      const entry = await must(await node.vault.get<Json>(key("etag"), { source: "network" }));
      expect(entry.etag).toMatch(BLAKE3_ETAG);

      const raw = await must(await node.kv.get<string>(`vault/${key("etag")}`, { raw: true, source: "network" }));
      expect(entry.etag).toBe(raw.headers.etag);

      const classified = await node.vault.readNetworkEncrypted<Json>(key("etag"));
      expect(classified.status === "ok" && classified.entry.etag).toBe(entry.etag);

      const plain = await must(await node.vault.get<Json>(key("etag")));
      expect(plain.etag).toBeUndefined();
    });

    test("a missing key is a classified not_found", async () => {
      expect(await node.vault.readNetworkEncrypted(key("never-written"))).toEqual({ status: "not_found" });
    });

    test("every write changes the etag, even with identical plaintext", async () => {
      await must(await node.vault.put(key("rewrite"), { n: 1 }));
      const first = await readEtag(node, "rewrite");
      await must(await node.vault.put(key("rewrite"), { n: 1 }));
      expect(await readEtag(node, "rewrite")).not.toBe(first);
    });
  });

  describe("ifMatch compare-and-swap", () => {
    test("writes with the current etag, then refuses the now-stale one", async () => {
      await must(await node.vault.put(key("cas"), { n: 1 }));
      const stale = await readEtag(node, "cas");

      await must(await node.vault.put(key("cas"), { n: 2 }, { ifMatch: stale }));
      const current = await must(await node.vault.get<Json>(key("cas"), { source: "network" }));
      expect(current.value).toEqual({ n: 2 });
      expect(current.etag).not.toBe(stale);

      const refused = await node.vault.put(key("cas"), { n: 3 }, { ifMatch: stale });
      expect(!refused.ok && refused.error.code).toBe("ETAG_MISMATCH");
      expect((await must(await node.vault.get<Json>(key("cas"), { source: "network" }))).value).toEqual({ n: 2 });
    });

    test("N writers on one etag: exactly one wins, every loser is ETAG_MISMATCH", async () => {
      const writers = Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? node : web));
      await must(await node.vault.put(key("race"), { round: -1 }));
      for (let round = 0; round < 5; round++) {
        const etag = await readEtag(node, "race");
        const results = await Promise.all(
          writers.map((client, writer) =>
            client.vault.put(key("race"), { round, writer }, { ifMatch: etag }),
          ),
        );
        const winners = results.flatMap((result, writer) => (result.ok ? [writer] : []));
        expect(winners).toHaveLength(1);
        for (const result of results) {
          if (!result.ok) expect(result.error.code).toBe("ETAG_MISMATCH");
        }
        const stored = await must(await node.vault.get<Json>(key("race"), { source: "network" }));
        expect(stored.value).toEqual({ round, writer: winners[0] });
      }
    });

    test("a loser re-reads and retries to a consistent outcome (CAS loop)", async () => {
      await must(await node.vault.put(key("loop"), { items: [] }));
      const add = async (client: TinyCloudNode, item: string): Promise<void> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const read = await must(await client.vault.get<{ items: string[] }>(key("loop"), { source: "network" }));
          const result = await client.vault.put(
            key("loop"),
            { items: [...read.value.items, item] },
            { ifMatch: read.etag! },
          );
          if (result.ok) return;
          if (result.error.code !== "ETAG_MISMATCH") throw new Error(result.error.code);
        }
        throw new Error("CAS did not converge");
      };
      const items = Array.from({ length: 6 }, (_, index) => `item-${index}`);
      await Promise.all(items.map((item, index) => add(index % 2 === 0 ? node : web, item)));
      const final = await must(await node.vault.get<{ items: string[] }>(key("loop"), { source: "network" }));
      expect([...final.value.items].sort()).toEqual(items);
    });

    test("a deleted key, and a key that never existed, are ETAG_MISMATCH", async () => {
      await must(await node.vault.put(key("deleted"), { n: 1 }));
      const etag = await readEtag(node, "deleted");
      await must(await node.vault.delete(key("deleted")));

      const afterDelete = await node.vault.put(key("deleted"), { n: 2 }, { ifMatch: etag });
      expect(!afterDelete.ok && afterDelete.error.code).toBe("ETAG_MISMATCH");
      const neverExisted = await node.vault.put(key("ghost"), { n: 2 }, { ifMatch: etag });
      expect(!neverExisted.ok && neverExisted.error.code).toBe("ETAG_MISMATCH");
      // Neither refused write created the key.
      expect(await node.vault.readNetworkEncrypted(key("deleted"))).toEqual({ status: "not_found" });
      expect(await node.vault.readNetworkEncrypted(key("ghost"))).toEqual({ status: "not_found" });
    });

    test("malformed etags are INVALID_ETAG, distinct from a mismatch, and write nothing", async () => {
      await must(await node.vault.put(key("quoting"), { n: 1 }));
      const etag = await readEtag(node, "quoting");

      // Refused client-side, before any request.
      for (const bad of [`W/${etag}`, etag.replaceAll('"', ""), "", `${etag.slice(0, -1)}`]) {
        const result = await node.vault.put(key("quoting"), { n: 2 }, { ifMatch: bad });
        expect(!result.ok && result.error.code).toBe("INVALID_ETAG");
      }

      // Well-formed quoting but not a TinyCloud etag: the node's 400 maps to the same code.
      const nonsense = await node.vault.put(key("quoting"), { n: 2 }, { ifMatch: '"not-a-blake3-etag"' });
      expect(!nonsense.ok && nonsense.error.code).toBe("INVALID_ETAG");
      expect(!nonsense.ok && nonsense.error.meta?.status).toBe(400);

      // The node itself rejects the weak and unquoted forms the client refuses.
      for (const bad of [`W/${etag}`, etag.replaceAll('"', "")]) {
        const raw = await node.kv.put(`vault/${key("quoting")}`, "{}", { ifMatch: bad });
        expect(!raw.ok && raw.error.meta?.status).toBe(400);
      }

      expect((await must(await node.vault.get<Json>(key("quoting"), { source: "network" }))).value).toEqual({ n: 1 });
      expect(await readEtag(node, "quoting")).toBe(etag);
    });

    test("ifMatch and ifNoneMatch cannot be combined", async () => {
      await must(await node.vault.put(key("both"), { n: 1 }));
      const etag = await readEtag(node, "both");
      const result = await node.vault.put(key("both"), { n: 2 }, { ifMatch: etag, ifNoneMatch: "*" });
      expect(result.ok).toBe(false);
      expect(await readEtag(node, "both")).toBe(etag);
    });
  });

  describe("expectAad (opt-in)", () => {
    test("an envelope copied to another key still decrypts by default and fails with expectAad", async () => {
      await must(await node.vault.put(key("source"), { secret: "record A" }));
      const raw = await must(await node.kv.get<string>(`vault/${key("source")}`, { raw: true, source: "network" }));
      await must(await node.kv.put(`vault/${key("swapped")}`, raw.data));

      // Default off: unchanged behaviour (the gap this option exists to close).
      expect((await must(await node.vault.get<Json>(key("swapped")))).value).toEqual({ secret: "record A" });

      const strict = await node.vault.get<Json>(key("swapped"), { expectAad: true, source: "network" });
      expect(!strict.ok && strict.error.code).toBe("AAD_MISMATCH");
      expect(await node.vault.readNetworkEncrypted(key("swapped"), { expectAad: true })).toEqual({
        status: "aad_mismatch",
      });

      // The key it was written for still reads.
      const home = await must(await node.vault.get<Json>(key("source"), { expectAad: true, source: "network" }));
      expect(home.value).toEqual({ secret: "record A" });
    });

    test("a record envelope copied over an index key is refused", async () => {
      await must(await node.vault.put(key("records/shareA"), { shareId: "shareA" }));
      const raw = await must(await node.kv.get<string>(`vault/${key("records/shareA")}`, { raw: true, source: "network" }));
      await must(await node.kv.put(`vault/${key("records/_index/main")}`, raw.data));
      const read = await node.vault.readNetworkEncrypted(key("records/_index/main"), { expectAad: true });
      expect(read).toEqual({ status: "aad_mismatch" });
    });

    test("a stored value that is not an envelope is corrupt_envelope with or without expectAad", async () => {
      for (const [name, body] of [
        ["null", "null"],
        ["number", "42"],
        ["string", '"text"'],
        ["array", "[]"],
        ["empty-object", "{}"],
      ] as const) {
        await must(await node.kv.put(`vault/${key(`malformed-${name}`)}`, body));
        expect(await node.vault.readNetworkEncrypted(key(`malformed-${name}`))).toEqual({ status: "corrupt_envelope" });
        expect(await node.vault.readNetworkEncrypted(key(`malformed-${name}`), { expectAad: true })).toEqual({
          status: "corrupt_envelope",
        });
      }
    });

    test("an envelope written without AAD is an explicit aad_mismatch, and reads by default", async () => {
      await putRawEnvelope("legacy", { legacy: true });
      expect((await must(await node.vault.get<Json>(key("legacy")))).value).toEqual({ legacy: true });
      expect(await node.vault.readNetworkEncrypted(key("legacy"), { expectAad: true })).toEqual({
        status: "aad_mismatch",
      });
      const strict = await node.vault.get<Json>(key("legacy"), { expectAad: true });
      expect(!strict.ok && strict.error.code).toBe("AAD_MISMATCH");
    });

    test("the address spelling in the bound space id does not matter", async () => {
      const space = node.spaceId!;
      const address = /0x[0-9a-fA-F]{40}/.exec(space)![0];
      expect(address).not.toBe(address.toLowerCase()); // checksummed, so the lowercase form really differs

      for (const [name, spelling] of [
        ["spelled-lower", space.replace(address, address.toLowerCase())],
        ["spelled-checksummed", space],
      ] as const) {
        await putRawEnvelope(name, { name }, `tinycloud.vault:${spelling}:${key(name)}`);
        const read = await node.vault.readNetworkEncrypted<Json>(key(name), { expectAad: true });
        expect(read.status).toBe("ok");
      }

      // A different account's address is a different space, however it is spelled.
      const other = space.replace(address, "0x1111111111111111111111111111111111111111");
      await putRawEnvelope("other-space", {}, `tinycloud.vault:${other}:${key("other-space")}`);
      expect(await node.vault.readNetworkEncrypted(key("other-space"), { expectAad: true })).toEqual({
        status: "aad_mismatch",
      });
    });
  });

  describe("node SDK and web SDK interoperate with enforcement on", () => {
    test("node-written values read with expectAad on the web SDK, and the reverse, with equal etags", async () => {
      await must(await node.vault.put(key("from-node"), { by: "node" }));
      await must(await web.vault.put(key("from-web"), { by: "web" }));

      for (const [name, by] of [
        ["from-node", "node"],
        ["from-web", "web"],
      ] as const) {
        const viaNode = await must(await node.vault.get<Json>(key(name), { expectAad: true, source: "network" }));
        const viaWeb = await must(await web.vault.get<Json>(key(name), { expectAad: true, source: "network" }));
        expect(viaNode.value).toEqual({ by });
        expect(viaWeb.value).toEqual({ by });
        expect(viaWeb.etag).toBe(viaNode.etag);
      }
    });

    test("an ifMatch write by one SDK is accepted on an etag read by the other", async () => {
      await must(await node.vault.put(key("handoff"), { n: 1 }));
      const etag = await readEtag(web, "handoff");
      await must(await node.vault.put(key("handoff"), { n: 2 }, { ifMatch: etag }));
      const next = await readEtag(node, "handoff");
      await must(await web.vault.put(key("handoff"), { n: 3 }, { ifMatch: next }));
      expect((await must(await node.vault.get<Json>(key("handoff"), { expectAad: true, source: "network" }))).value).toEqual({ n: 3 });
    });

    test("secrets written by either SDK stay readable with enforcement on", async () => {
      const secretsVault = (client: TinyCloudNode) => client.spaces.get("secrets").vault;
      await must(await node.secrets.put(`CAS_AAD_NODE_${RUN}`, "node-secret"));
      await must(await web.secrets.put(`CAS_AAD_WEB_${RUN}`, "web-secret"));

      for (const [name, value] of [
        [`CAS_AAD_NODE_${RUN}`, "node-secret"],
        [`CAS_AAD_WEB_${RUN}`, "web-secret"],
      ] as const) {
        for (const reader of [node, web]) {
          expect(await must(await reader.secrets.get(name))).toBe(value);
          const strict = await secretsVault(reader).readNetworkEncrypted<{ value: string }>(`secrets/${name}`, {
            expectAad: true,
          });
          expect(strict.status === "ok" && strict.entry.value.value).toBe(value);
        }
      }
    });
  });
});
