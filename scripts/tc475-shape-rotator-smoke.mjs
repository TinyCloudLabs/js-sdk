/**
 * Drives the first TC-475 contract boundary against running local services.
 *
 * The services are real processes: CoordinationOS must be reachable through
 * OpenCredentials, and this script only rewrites the fixture issuer origin to
 * its local listener.  It does not synthesize an HTTP response or invoke a
 * service implementation in-process.
 */
import { canonicalDigest, validateCredentialFlowDescriptor } from "../packages/sdk-core/src/credentials/index.ts";
import { OpenCredentialsHttpTransport } from "../packages/web-sdk/src/credentials/transport.ts";

const origin = process.env.TC475_OPEN_CREDENTIALS_URL;
if (!origin) throw new Error("TC475_OPEN_CREDENTIALS_URL is required");
const local = new URL(origin);
if (local.protocol !== "http:" || local.hostname !== "127.0.0.1") throw new Error("TC475_OPEN_CREDENTIALS_URL must be a loopback HTTP fixture URL");

const catalogResponse = await fetch(new URL("/.well-known/opencredentials", local), { cache: "no-store", redirect: "error" });
if (!catalogResponse.ok) throw new Error(`catalog request failed: ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const profile = catalog.profiles?.find((entry) => entry.profile === "shape-rotator.membership/v1");
if (!profile?.descriptor) throw new Error("Shape Rotator descriptor is missing from the live catalog");
let descriptor;
try {
  descriptor = validateCredentialFlowDescriptor(profile.descriptor);
} catch (error) {
  console.log(JSON.stringify({
    descriptorAccepted: false,
    stage: "descriptor_validation",
    code: error?.code ?? "UNKNOWN",
    message: error?.message ?? String(error),
  }));
  process.exit(1);
}
const requirement = {
  type: "TinyCloudCredentialRequirement", version: 1,
  profile: { id: descriptor.profile, version: 1 },
  credentialType: { id: descriptor.format.vct, version: 1 },
  claims: { space: "SR", role: "creator", team: "rotators", cohort: "shape-rotator" },
};
const transport = new OpenCredentialsHttpTransport(descriptor, (url, init) => {
  const remote = new URL(String(url));
  if (remote.origin !== descriptor.issuer.origin) throw new Error("unexpected OpenCredentials origin");
  return fetch(new URL(`${remote.pathname}${remote.search}`, local), init);
});

let creationError;
try {
  await transport.create({
    descriptor,
    descriptorDigest: await canonicalDigest(descriptor),
    requirement,
    requirementDigest: await canonicalDigest(requirement),
    holderDid: "did:key:z6MkhappyPathHolder",
    openerOrigin: "https://app.test",
    completionVerifierChallenge: "A".repeat(43),
  });
} catch (error) {
  creationError = error;
}
if (!creationError) throw new Error("the v1 creation contract unexpectedly accepted a request without an invite proof");
console.log(JSON.stringify({
  descriptorAccepted: true,
  stage: "create_without_proof",
  code: creationError?.code ?? "UNKNOWN",
  message: creationError?.message ?? String(creationError),
}));
process.exitCode = 1;
