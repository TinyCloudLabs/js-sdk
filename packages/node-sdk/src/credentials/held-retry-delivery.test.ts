import { describe, expect, test } from "bun:test";
import { completeEmailProofWithIssuerKeys, EmailProofError, requestEmailProofCode } from "./email-proof";
import { validateCredentialFlowDescriptor } from "@tinycloud/sdk-core";
import { OpenCredentialsHttpTransport } from "./transport";
import { createHeldWitness, testAccountHolder, vectors, type HeldWitnessOptions } from "./test-support/held-witness";

// TC-2254 A2.2 (C8.6 (3), second bullet; S11 (e)): a held completion retried after an R7 notice failure sends R0, R2, R5 (checked in full,
// as before signing), R7, R8. No R6, no wallet prompt, no R3/R4. (vi) and (viii) are judged against the R5 binding of the retry.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE = "alice@example.com";
const T0 = Date.parse("2026-10-30T06:53:00Z");

function world(options: Omit<HeldWitnessOptions, "serverClock"> = {}) {
  const witness = createHeldWitness({ ...options, serverClock: () => T0 });
  const holder = testAccountHolder(ANVIL_0);
  const now = () => new Date(T0);
  const complete = (pending: Awaited<ReturnType<typeof requestEmailProofCode>>) =>
    completeEmailProofWithIssuerKeys({ pending, code: "12345678", holder, fetch: witness.fetch, now, allowHeldProfile: true }, witness.issuerKeys);
  const request = () => requestEmailProofCode({ address: ALICE, holder, profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now });
  return { witness, holder, complete, request };
}
async function failure(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}
const routesAfter = (w: ReturnType<typeof createHeldWitness>, from: number) => w.calls.slice(from).map((c) => c.route);
const nonState = (routes: string[]) => routes.filter((r) => r !== "state");
const count = (w: ReturnType<typeof createHeldWitness>, kind: "code" | "notice") => w.mails.filter((m) => m.kind === kind).length;

describe("retry after a failed notice at R7", () => {
  test("1. the first completion is ISSUER_UNAVAILABLE, recoverable, and no notice is mailed", async () => {
    const w = world({ failNotice: 1 });
    const pending = await w.request();
    const error = await failure(() => w.complete(pending));
    expect([error?.code, error?.recoverable]).toEqual(["ISSUER_UNAVAILABLE", true]);
    expect(count(w.witness, "notice")).toBe(0);
  });

  test("2. the retry issues: routes without challenge, proof or holder-signature, one wallet call in all, one code mail, one notice, credentialId = the R5 jti", async () => {
    const w = world({ failNotice: 1 });
    const pending = await w.request();
    await failure(() => w.complete(pending));
    const before = w.witness.calls.length;
    const result = await w.complete(pending);
    expect(nonState(routesAfter(w.witness, before))).toEqual(["catalog", "holder-binding", "issue", "result"]);
    expect(routesAfter(w.witness, before)).toContain("state");
    expect(w.holder.calls.count).toBe(1);
    expect(count(w.witness, "code")).toBe(1);
    expect(count(w.witness, "notice")).toBe(1);
    const record = [...w.witness.records.values()][0]!;
    expect(result.credentialId).toBe(record.jti);
    expect(result.envelope.profile.id).toBe(HELD);
  });

  const changed: [string, (b: Record<string, unknown>) => Record<string, unknown>][] = [
    // A changed `jti` is not listed: the retry holds no earlier jti to compare with (A2.2 adds no pending field), so S11 (a) cannot see it before R7.
    // Awaiting the lead's ruling; (vi) still refuses a credential whose jti is not the R5 binding's.
    ["challengeNonce", (b) => ({ ...b, challengeNonce: "X".repeat(32) })],
    ["normalizedClaimsDigest", (b) => ({ ...b, normalizedClaimsDigest: "N".repeat(43) })],
    ["expiresAt", (b) => ({ ...b, expiresAt: new Date(Date.parse(String(b.expiresAt)) + 60_000).toISOString().replace(".000Z", "Z") })],
  ];
  for (const [field, retryBinding] of changed) {
    test(`3. a retry whose R5 binding has another ${field}: SESSION_INVALID, no issue call, no notice`, async () => {
      const w = world({ failNotice: 1, retryBinding });
      const pending = await w.request();
      await failure(() => w.complete(pending));
      const before = w.witness.calls.length;
      const error = await failure(() => w.complete(pending));
      expect([field, error?.code]).toEqual([field, "SESSION_INVALID"]);
      expect(routesAfter(w.witness, before)).not.toContain("issue");
      expect(routesAfter(w.witness, before)).not.toContain("result");
      expect(count(w.witness, "notice")).toBe(0);
    });
  }

  test("4. R5 failing with 503 on the retry is ISSUER_UNAVAILABLE and never a success without (vi)/(viii): no issue, no result", async () => {
    const w = world({ failNotice: 1 });
    const pending = await w.request();
    await failure(() => w.complete(pending));
    (w.witness.force as Record<string, unknown>)["holder-binding"] = { status: 503, body: { code: "ISSUER_UNREADY", correlationId: "c", recoverable: true, state: "issuer_unready", type: "tinycloud.credentials/error/v1" } };
    const before = w.witness.calls.length;
    const error = await failure(() => w.complete(pending));
    expect([error?.code, error?.recoverable]).toEqual(["ISSUER_UNAVAILABLE", true]);
    expect(routesAfter(w.witness, before)).not.toContain("issue");
    expect(routesAfter(w.witness, before)).not.toContain("result");
  });

  test("5. a lost issue response (R2 then says issued): steps R5 and R8 only, no second R7, one wallet call, one notice", async () => {
    const w = world();
    const pending = await w.request();
    // The witness issues and mails the notice, but the response never arrives (the first R7 answer is replaced).
    (w.witness.force as Record<string, unknown>)["issue"] = { status: 503, body: { code: "ISSUER_UNREADY", correlationId: "c", recoverable: true, state: "issuer_unready", type: "tinycloud.credentials/error/v1" } };
    expect((await failure(() => w.complete(pending)))?.recoverable).toBe(true);
    const before = w.witness.calls.length;
    const result = await w.complete(pending);
    expect(nonState(routesAfter(w.witness, before))).toEqual(["catalog", "holder-binding", "result"]);
    expect(w.holder.calls.count).toBe(1);
    expect(count(w.witness, "notice")).toBe(1);
    expect(result.credentialId).toBe([...w.witness.records.values()][0]!.jti);
  });
});

describe("the transport keeps the R2 challenge nonce in every state after the challenge (A2.2 step 2)", () => {
  const held = validateCredentialFlowDescriptor(vectors.descriptor.held);
  const ID = "R".repeat(32);
  const state = (name: string, challengeNonce: unknown) => ({ type: "tinycloud.credentials/acquisition-state/v1", requestId: ID, profile: HELD, profileVersion: 1, state: name, challengeNonce });
  function transportFor(bodies: unknown[]) {
    const fetchFn = Object.assign(async () => new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { "content-type": "application/json" } }), { preconnect: () => {} }) as typeof globalThis.fetch;
    return new OpenCredentialsHttpTransport(held, fetchFn, { allowAccountSubject: true });
  }

  for (const name of ["proof_required", "holder_binding_required", "holder_signature_required", "ready_to_issue", "issued"]) {
    test(`${name} without a nonce: REQUEST_SUBSTITUTED`, async () => {
      await expect(transportFor([state(name, null)]).state(ID, "v")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
    });
    test(`${name} with a nonce keeps it for the interpreter`, async () => {
      const transport = transportFor([state(name, "N".repeat(32))]);
      await transport.state(ID, "v");
      expect(transport.challengeNonce(ID)).toBe("N".repeat(32));
    });
  }

  test("a nonce that changes between two states of one transport is REQUEST_SUBSTITUTED", async () => {
    const transport = transportFor([state("holder_signature_required", "A".repeat(32)), state("ready_to_issue", "B".repeat(32))]);
    await transport.state(ID, "v");
    await expect(transport.state(ID, "v")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
  });
});
