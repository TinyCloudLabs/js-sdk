import {
  canonicalDigest,
  createEmailCredentialRequirement,
  credentialRequirementDigest,
  validateCredentialFlowDescriptor,
} from "@tinycloud/sdk-core";
import {
  publishAddressedShare,
  type AddressedSharePublishOptions,
  type PublishedShare,
} from "@tinycloud/share-sdk";
import productionEmailDescriptor from "./email-descriptor.json";

export type EmailPublishV3Input = AddressedSharePublishOptions & {
  readonly target: { readonly kind: "email"; readonly address: string };
  readonly credentialDescriptor: unknown;
  readonly issuerDid: string;
  readonly issuerKid: string;
};

/** Production pins match stable 1.4.0 and the issuer's published DID/catalog. */
export function resolveEmailCredentialInputs(input: {
  readonly credentialDescriptor?: unknown;
  readonly issuerDid?: string;
  readonly issuerKid?: string;
}) {
  const descriptor = validateCredentialFlowDescriptor(
    input.credentialDescriptor === undefined ? productionEmailDescriptor : input.credentialDescriptor,
  );
  const issuerDid = input.issuerDid ?? productionEmailDescriptor.issuer.did;
  const issuerKid = input.issuerKid ?? productionEmailDescriptor.issuer.kid;
  if (descriptor.issuer.did !== issuerDid || descriptor.issuer.kid !== issuerKid ||
      !descriptor.claims.some((claim) => claim.name === "email" && claim.matching === "normalized_exact")) {
    throw new TypeError("email credential issuer or claim is invalid");
  }
  return { credentialDescriptor: descriptor, issuerDid, issuerKid };
}

/** Publish one exact email share through the shared V3 envelope and v4 link path. */
export async function publishEmailShareV3(input: EmailPublishV3Input): Promise<PublishedShare> {
  const { contentSource } = input;
  if (input.resource.kind !== "exact" ||
      contentSource.encryptionKeyPath !== `share/${input.shareId}` ||
      !/^urn:tinycloud:encryption:did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:default$/.test(contentSource.encryptionNetwork)) {
    throw new TypeError("email share binding is invalid");
  }
  const { credentialDescriptor: descriptor, issuerDid, issuerKid } = resolveEmailCredentialInputs(input);
  const profile = { id: descriptor.profile, version: 1 as const };
  const credentialType = { id: descriptor.format.vct, version: 1 as const };
  const requirement = createEmailCredentialRequirement({ email: input.target.address, profile, credentialType });
  const credentialRequirement = {
    type: "TinyCloudPolicyCredentialRequirement" as const,
    version: 1 as const,
    requirementDigest: await credentialRequirementDigest(requirement),
    descriptorDigest: await canonicalDigest(descriptor),
    issuerDid,
    issuerKid,
    profile,
    credentialType,
  };
  return publishAddressedShare({ ...input, credentialRequirement });
}
