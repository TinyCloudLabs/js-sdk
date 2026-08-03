import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";

export const SHARE_V2_PROTOCOL = Object.freeze({
  challengeDomain: "xyz.tinycloud.share/policy-challenge/v2\0",
  sessionDomain: "xyz.tinycloud.share/policy-session/v2\0",
  invocationDomain: "xyz.tinycloud.share/invocation/v2\0",
  readResponseDomain: "xyz.tinycloud.share/read-response/v2\0",
  holderBindingDomain: "xyz.tinycloud.share/email-claim-holder-binding/v1\0",
  holderBindingName: "holderBinding",
  holderBindingType: "TinyCloudEmailClaimHolderBinding",
  holderBindingVersion: 1,
} as const);

export async function createShareV2HolderBindingArtifact(input: {
  readonly holderDid: string;
  readonly message: Record<string, unknown>;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}): Promise<Record<string, unknown>> {
  const jcs = canonicalize(input.message);
  const signedBytes = new TextEncoder().encode(`${SHARE_V2_PROTOCOL.holderBindingDomain}${jcs}`);
  const signature = await input.sign(signedBytes);
  return {
    name: SHARE_V2_PROTOCOL.holderBindingName,
    domain: SHARE_V2_PROTOCOL.holderBindingDomain,
    signerDid: input.holderDid,
    message: input.message,
    jcs,
    messageDigest: await digestText(jcs),
    signedBytesDigest: await digestBytes(signedBytes),
    signatureDigest: await digestBytes(signature),
    signature: {
      alg: "EdDSA",
      kid: `${input.holderDid}#${input.holderDid.slice("did:key:".length)}`,
      value: toBase64Url(signature),
    },
  };
}

async function digestText(value: string): Promise<string> {
  return digestBytes(new TextEncoder().encode(value));
}

async function digestBytes(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}
