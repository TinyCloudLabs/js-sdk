import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

// `tc secrets put` with TC_SECRETS_NAMED_KEY_WRITES=1 asks the owner for exactly: put and get on that one secret, and
// key.create plus decrypt on that one secret's own key on the default network. Never the network, a `secrets/` prefix
// or a scope folder. Without the opt-in a put asks for no encryption authority at all.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-put-request-"));
process.env.TC_HOME = home;
const { secretPermissionEntries } = await import("./secrets.js");

const OWNER = "did:pkh:eip155:1:0xe8c2ab8468210C4b507C0563A10da60990eaa792";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const nodeOn = (networkId: string) => ({
  getEncryptionNetworkIdForSpace: () => networkId,
  getDefaultEncryptionNetworkId: () => networkId,
}) as unknown as TinyCloudNode;

const put = (name: string, scope: string | undefined, namedKey: boolean, networkId = NETWORK) =>
  secretPermissionEntries({ action: "put", name, options: scope === undefined ? {} : { scope }, node: nodeOn(networkId), namedKey });
const kv = (entries: ReturnType<typeof put>) => entries.filter((entry) => entry.service === "tinycloud.kv");
const encryption = (entries: ReturnType<typeof put>) => entries.filter((entry) => entry.service === "tinycloud.encryption");

test("the opt-in put asks put+get on the one secret and key.create+decrypt on its exact key only", () => {
  const entries = put("RESEND_API_KEY", undefined, true);
  expect(kv(entries)).toEqual([expect.objectContaining({ path: "vault/secrets/RESEND_API_KEY", actions: ["tinycloud.kv/put", "tinycloud.kv/get"] })]);
  expect(encryption(entries)).toEqual([
    expect.objectContaining({ path: `${NETWORK}/secrets/resend_api_key`, actions: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"] }),
  ]);
});

test("a scoped secret's request names its own scoped key, never the scope folder or the network", () => {
  const encryptionEntries = encryption(put("TOKEN", "my-app", true));
  expect(encryptionEntries.map((entry) => entry.path)).toEqual([`${NETWORK}/secrets/scoped/my-app/token`]);
  for (const entry of encryptionEntries) {
    expect(entry.path).not.toBe(NETWORK);
    expect(entry.path.endsWith("/")).toBe(false);
    expect(entry.path.endsWith("/secrets")).toBe(false);
    expect(entry.path.endsWith("/scoped/my-app")).toBe(false);
  }
});

test("without the opt-in a put asks for no encryption authority, and a non-default network gets no key", () => {
  expect(encryption(put("RESEND_API_KEY", undefined, false))).toEqual([]);
  expect(encryption(put("RESEND_API_KEY", undefined, true, `urn:tinycloud:encryption:${OWNER}:work`))).toEqual([]);
});

test("the opt-in request is the same for every secret: one key.create+decrypt entry, nothing wider", () => {
  for (const [name, scope] of [["A", undefined], ["MY_SECRET", "prod"], ["X1", "a-b-c"]] as const) {
    const entries = encryption(put(name, scope, true));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toMatch(/^urn:tinycloud:encryption:did:pkh:eip155:1:0x[0-9a-fA-F]{40}:default\/secrets\/(?:scoped\/[a-z0-9-]+\/)?[a-z0-9_]+$/);
    expect(entries[0]!.actions).toEqual(["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"]);
  }
});
