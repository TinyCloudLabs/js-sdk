/**
 * Capture a real CLI V3 email publication for TC-2202 interoperability.
 * Requires an authenticated owner profile and reachable Share/Node services.
 * The output directory is private and must not exist before this script runs.
 * Node admission and decrypt responses are produced by the receiver test.
 *
 * bun packages/cli/scripts/capture-email-share-v3-fixture.ts \
 *   <profile> <input-file> <recipient-email> <descriptor.json> \
 *   <issuer-did> <issuer-kid> <output-directory>
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { publishTargetShare } from "@tinycloud/share-sdk";
import {
  shareEnvelopeV3Schema,
  verifyEnvelopeV3SignatureOnly,
} from "@tinycloud/share-envelope";
import { DEFAULT_LINKS_API_ORIGIN, resolveLink } from "@tinycloud/share-envelope/links";
import { ProfileManager } from "../src/config/profiles.js";
import { ensureAuthenticated } from "../src/lib/sdk.js";
import { createShareAuthorityAdapters } from "../src/share/adapters.js";

const [profile, inputFile, email, descriptorFile, issuerDid, issuerKid, outputDirectory] = process.argv.slice(2);
if (!profile || !inputFile || !email || !descriptorFile || !issuerDid || !issuerKid || !outputDirectory) {
  throw new Error("expected profile, input file, recipient email, descriptor, issuer DID, issuer key ID, and output directory");
}

const shareOrigin = "https://share.tinycloud.xyz";
const configResponse = await fetch(`${shareOrigin}/.well-known/tinycloud-share/config.json`, {
  headers: { accept: "application/json" }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
});
if (!configResponse.ok) throw new Error("Share public configuration is unavailable");
const config = await configResponse.json() as { nodeOrigin?: string };
if (typeof config.nodeOrigin !== "string") throw new Error("Share public configuration has no Node origin");
const context = await ProfileManager.resolveContext({ profile, host: config.nodeOrigin });
const node = await ensureAuthenticated(context);
if (!node.spaceId) throw new Error("owner profile has no space");

const source = new Uint8Array(await readFile(inputFile));
const filename = basename(inputFile);
const descriptor = JSON.parse(await readFile(descriptorFile, "utf8")) as unknown;
await mkdir(outputDirectory, { mode: 0o700 });
const authority = createShareAuthorityAdapters({ profileName: async () => profile, fetchFn: globalThis.fetch });
const result = await publishTargetShare({
  source, filename, files: [{ bytes: source, filename, mediaType: "text/plain" }],
  mediaType: "text/plain", target: { kind: "email", address: email }, resourceKind: "exact",
  actions: ["read"], expiresAt: new Date(Date.now() + 60 * 60 * 1000), origin: shareOrigin,
  targetAdapter: authority.targetAdapter,
  credentialDescriptor: descriptor, issuerDid, issuerKid,
});
if ("state" in result || result.metadata.envelopeVersion !== 3 || result.link.kind !== "policy") {
  throw new Error("publisher did not produce a V3 email policy share");
}

const resolved = await resolveLink(result.url, {
  trustedOrigins: [shareOrigin], apiOrigin: DEFAULT_LINKS_API_ORIGIN,
});
if (resolved.form !== "full" || resolved.type !== "share" || resolved.header.bodyCid !== result.link.cid) {
  throw new Error("publisher did not produce a signed V4 Share link record");
}
const sealedBlob = resolved.body;
const envelope = shareEnvelopeV3Schema.parse(resolved.value);
if (!verifyEnvelopeV3SignatureOnly(envelope)) throw new Error("V3 envelope signature is invalid");
const networkId = node.getDefaultEncryptionNetworkId();
const keyPath = `share/${envelope.shareId}`;
const leaf = `${networkId}/${keyPath}`;
if (envelope.encryptionNetwork !== networkId || envelope.contentSource.encryptionKeyPath !== keyPath ||
    !envelope.policy.capabilityCeiling.some((capability) => capability.kind === "encryption" && capability.resource === leaf)) {
  throw new Error("publisher did not bind the default-network share leaf");
}
const read = await node.kvForSpace(node.spaceId).get<Uint8Array>(envelope.resource.path, { binary: true });
if (!read.ok || !(read.data.data instanceof Uint8Array)) throw new Error("owner KV encrypted bytes could not be read");
const storedBytes = read.data.data;
const stored = JSON.parse(new TextDecoder().decode(storedBytes)) as Record<string, unknown>;
if (stored.networkId !== networkId || stored.keyPath !== keyPath ||
    stored.encryptedSymmetricKeyHash !== envelope.contentSource.encryptedSymmetricKeyDigestHex ||
    stored.keyVersion !== envelope.contentSource.keyVersion ||
    createHash("sha256").update(storedBytes).digest("hex") !== envelope.contentSource.initialCiphertextDigestHex) {
  throw new Error("owner KV bytes do not match the published content source");
}

await writeFile(join(outputDirectory, "link.txt"), `${result.url}\n`, { mode: 0o600, flag: "wx" });
await writeFile(join(outputDirectory, "sealed-envelope.bin"), sealedBlob, { mode: 0o600, flag: "wx" });
await writeFile(join(outputDirectory, "envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await writeFile(join(outputDirectory, "owner-kv-envelope.bin"), storedBytes, { mode: 0o600, flag: "wx" });
await writeFile(join(outputDirectory, "binding.json"), `${JSON.stringify({
  networkId, keyPath, leaf, pastePrefix: `${networkId}/share/`,
  kvPath: envelope.resource.path, policyCid: envelope.policyCid,
  policyRootCid: envelope.policyRoot.cid, enforcementRootCid: envelope.enforcementRoot.cid,
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${outputDirectory}\n`);
