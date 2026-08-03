import { createHash } from "node:crypto";
import { canonicalDigest } from "../packages/sdk-core/src/credentials/digest";
import { validateCredentialFlowDescriptor } from "../packages/sdk-core/src/credentials/descriptor";
import { holderBindingCanonicalBytes, validateCredentialHolderBinding } from "../packages/sdk-core/src/credentials/binding";

const flag = process.argv.indexOf("--opencredentials-root");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("--opencredentials-root is required");
const source = `${process.argv[flag + 1]}/rust/opencredentials_witness/specs/credential-acquisition-v1`;
const vendor = new URL("../packages/sdk-core/test-fixtures/opencredentials-v1/", import.meta.url).pathname;
const manifest = await Bun.file(`${vendor}/manifest.json`).json() as { files: Record<string, string> };

for (const [name, expected] of Object.entries(manifest.files)) {
  const [canonical, copy] = await Promise.all([Bun.file(`${source}/${name}`).bytes(), Bun.file(`${vendor}/${name}`).bytes()]);
  if (!canonical.length || canonical.length !== copy.length || canonical.some((byte, index) => byte !== copy[index])) throw new Error(`${name} is not byte-identical to OpenCredentials`);
  if (createHash("sha256").update(copy).digest("hex") !== expected) throw new Error(`${name} does not match the vendored digest manifest`);
}

const descriptors = await Bun.file(`${vendor}/golden-descriptor-digests.json`).json() as { vectors: { name: string; descriptor: unknown; digest: string }[] };
for (const vector of descriptors.vectors) {
  const descriptor = validateCredentialFlowDescriptor(vector.descriptor);
  const digest = await canonicalDigest(descriptor);
  if (digest !== vector.digest) throw new Error(`${vector.name} descriptor digest mismatch: ${digest}`);
}

const bindingVector = await Bun.file(`${vendor}/golden-holder-binding.json`).json() as { binding: unknown; canonical: string; digest: string };
const binding = validateCredentialHolderBinding(bindingVector.binding);
const canonical = new TextDecoder().decode(holderBindingCanonicalBytes(binding));
if (canonical !== bindingVector.canonical || await canonicalDigest(binding) !== bindingVector.digest) throw new Error("holder-binding golden vector mismatch");

console.log(JSON.stringify({ contract: "tinycloud.credentials/acquisition/v1", byteIdenticalFiles: Object.keys(manifest.files).length, descriptorVectors: descriptors.vectors.length, holderBindingVectors: 1 }));
