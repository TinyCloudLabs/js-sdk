import { createHash } from "node:crypto";
import Ajv2020 from "../node_modules/ajv-formats/node_modules/ajv/dist/2020.js";
import addFormats from "../node_modules/ajv-formats/dist/index.js";
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

const [acquisitionSchema, descriptorSchema, registrySchema, catalogSchema] = await Promise.all([
  Bun.file(`${vendor}/acquisition.schema.json`).json(),
  Bun.file(`${vendor}/descriptor.schema.json`).json(),
  Bun.file(`${vendor}/step-registry.schema.json`).json(),
  Bun.file(`${vendor}/catalog.schema.json`).json(),
]);
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(acquisitionSchema).addSchema(registrySchema).addSchema(descriptorSchema).addSchema(catalogSchema);
const validateAcquisitionSchema = ajv.getSchema(acquisitionSchema.$id)!;
const validateDescriptorSchema = ajv.getSchema(descriptorSchema.$id)!;
const validateRegistrySchema = ajv.getSchema(registrySchema.$id)!;
const validateCatalogSchema = ajv.getSchema(catalogSchema.$id)!;
for (const vector of descriptors.vectors) {
  if (!validateDescriptorSchema(vector.descriptor)) throw new Error(`${vector.name} fails descriptor.schema.json: ${ajv.errorsText(validateDescriptorSchema.errors)}`);
}
const registry = {
  type: "tinycloud.credentials/steps/v1", version: 1, unknownStepBehavior: "fail_closed",
  steps: [
    { type: "collect_input", version: 1, network: false },
    { type: "mailbox_otp", version: 1, network: true, endpoint: "challenge" },
    { type: "holder_signature", version: 1, network: true, endpoint: "holder_signature" },
  ],
  registeredEndpoints: {
    request: "/v1/acquisitions", state: "/v1/acquisitions/{requestId}/state",
    challenge: "/v1/acquisitions/{requestId}/challenge", proof: "/v1/acquisitions/{requestId}/proof",
    holder_binding: "/v1/acquisitions/{requestId}/holder-binding", holder_signature: "/v1/acquisitions/{requestId}/holder-signature",
    issue: "/v1/acquisitions/{requestId}/issue", result: "/v1/acquisitions/{requestId}/result",
  },
};
if (!validateRegistrySchema(registry)) throw new Error(`canonical registry fails its schema: ${ajv.errorsText(validateRegistrySchema.errors)}`);
const catalog = {
  type: "tinycloud.credentials/catalog/v1", protocol: "tinycloud.credentials/acquisition/v1", catalogVersion: 1,
  canonicalization: "RFC8785", digest: "sha-256-base64url-nopad", stepRegistry: registry,
  issuerMetadata: {
    type: "tinycloud.credentials/issuer-metadata/v1", issuer: "did:web:issuer.credentials.org", origin: "https://witness.credentials.org",
    formats: ["vc+sd-jwt"], keys: [{ kid: "did:web:issuer.credentials.org#controller", version: 1, state: "active" }],
    rotation: { overlapSeconds: 86400, retiredKeysFailClosed: true },
    trust: { httpsOriginRequired: true, didDocumentRequired: true, unknownKeysFailClosed: true },
    cache: { maxAgeSeconds: 300, revalidateWith: "ETag", invalidateOnUnknownKid: true },
  },
  cache: { maxAgeSeconds: 300, staleIfErrorSeconds: 3600, revalidateWith: "ETag" },
  profiles: descriptors.vectors.map((vector) => ({ profile: (vector.descriptor as any).profile, profileVersion: 1, descriptorDigest: vector.digest, supported: true, enabled: true, readiness: "ready", descriptor: vector.descriptor })),
};
if (!validateCatalogSchema(catalog)) throw new Error(`canonical catalog fails its schema: ${ajv.errorsText(validateCatalogSchema.errors)}`);
const acquisition = {
  protocol: "tinycloud.credentials/acquisition/v1", profile: (descriptors.vectors[1]!.descriptor as any).profile, profileVersion: 1,
  descriptorDigest: descriptors.vectors[1]!.digest, requirementDigest: "R".repeat(43),
  holderDid: "did:key:z6MkiTBz1ymQWz2LdoV3frTSRHfwj2U8xqF8q7YrFzAWdV8C", inputs: { handle: "fixture_handle" },
  audience: "tinycloud://credentials", openerOrigin: "https://app.example", completionOrigin: "https://app.example",
  completionContext: "fixture", completionVerifierChallenge: "V".repeat(43),
};
if (!validateAcquisitionSchema(acquisition)) throw new Error(`canonical acquisition fails its schema: ${ajv.errorsText(validateAcquisitionSchema.errors)}`);
const clone = <T>(value: T): T => structuredClone(value);
const malformed: unknown[] = [];
const extraDisplay = clone(descriptors.vectors[0]!.descriptor as any); extraDisplay.display.unknown = true; malformed.push(extraDisplay);
const badInput = clone(descriptors.vectors[0]!.descriptor as any); badInput.inputs[0].schema.maxLength = "320"; malformed.push(badInput);
const badStep = clone(descriptors.vectors[0]!.descriptor as any); badStep.steps[0].version = 2; malformed.push(badStep);
const badEndpoint = clone(descriptors.vectors[0]!.descriptor as any); badEndpoint.endpoints.result = "https://evil.test/result"; malformed.push(badEndpoint);
for (const [index, document] of malformed.entries()) if (validateDescriptorSchema(document)) throw new Error(`malformed descriptor fixture ${index} unexpectedly passed its schema`);
const badRegistry = clone(registry); (badRegistry.steps[1] as any).endpoint = "result";
if (validateRegistrySchema(badRegistry)) throw new Error("malformed registry endpoint unexpectedly passed its schema");
const badCatalog = clone(catalog); (badCatalog.issuerMetadata.keys[0] as any).unknown = true;
if (validateCatalogSchema(badCatalog)) throw new Error("unknown issuer-key metadata unexpectedly passed the catalog schema");
const badAcquisition = clone(acquisition); badAcquisition.holderDid += `#${badAcquisition.holderDid.slice("did:key:".length)}`;
if (validateAcquisitionSchema(badAcquisition)) throw new Error("DID URL unexpectedly passed the bare holder-principal schema");

const bindingVector = await Bun.file(`${vendor}/golden-holder-binding.json`).json() as { binding: unknown; canonical: string; digest: string };
const binding = validateCredentialHolderBinding(bindingVector.binding);
const canonical = new TextDecoder().decode(holderBindingCanonicalBytes(binding));
if (canonical !== bindingVector.canonical || await canonicalDigest(binding) !== bindingVector.digest) throw new Error("holder-binding golden vector mismatch");

console.log(JSON.stringify({ contract: "tinycloud.credentials/acquisition/v1", byteIdenticalFiles: Object.keys(manifest.files).length, descriptorVectors: descriptors.vectors.length, holderBindingVectors: 1, schemaPositiveDocuments: descriptors.vectors.length + 3, schemaNegativeDocuments: malformed.length + 3 }));
