import { describe, expect, test } from "bun:test";
import { ShareReceiveError } from "@tinycloud/share-sdk";
import type { CredentialRequirement } from "@tinycloud/sdk-core";
import type { EmailProofResult } from "./credentials/email-proof";
import { openVerifiedAgentShare } from "./share-receive-access";
import type { AgentShareReceiveOptions, PendingAgentShareReceive } from "./share-receive";

// TC-2254: share receive runs on the ticket (did:key) credential only. A held (account) result handed to it is refused before anything else
// is read; a ticket result is judged as before (here: it passes the requirement match and reaches the Node-binding check).
const HOLDER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const NOW = new Date("2026-10-30T07:00:00Z");
const requirementFor = (profileId: string): CredentialRequirement => ({ type: "TinyCloudCredentialRequirement", version: 1, profile: { id: profileId, version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" } });
const resultFor = (profileId: string): EmailProofResult => {
  const verified = { profile: { id: profileId, version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" }, holderDid: HOLDER, expiresAt: "2027-10-30T00:00:00Z", issuedAt: "2026-10-30T06:00:00Z" };
  return { envelope: { profile: { id: profileId, version: 1 } }, verified } as unknown as EmailProofResult;
};
const pending = { envelope: { target: { nodeAudience: "did:key:a" }, attestedEnforcerBinding: { nodeAudience: "did:key:b" } } } as unknown as PendingAgentShareReceive;
const options = { holder: { did: HOLDER }, now: () => NOW } as unknown as AgentShareReceiveOptions;

describe("share receive accepts ticket results only", () => {
  test("a held result is refused authorization-denied before the share envelope is read", async () => {
    const error = await openVerifiedAgentShare(pending, resultFor("tinycloud.email-held/v1"), requirementFor("tinycloud.email-held/v1"), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShareReceiveError);
    expect((error as ShareReceiveError).code).toBe("authorization-denied");
  });

  test("a ticket result matching the requirement goes on to the Node-binding check (unchanged behaviour)", async () => {
    const error = await openVerifiedAgentShare(pending, resultFor("tinycloud.email-proof/v1"), requirementFor("tinycloud.email-proof/v1"), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShareReceiveError);
    expect((error as ShareReceiveError).code).toBe("envelope-invalid");
  });
});
