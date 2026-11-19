import { describe, expect, test } from "bun:test";
import { acquireEmailProofWithIssuerKeys, createMemoryEmailProofPendingStore, EmailProofError } from "./email-proof";
import { createHeldWitness, testAccountHolder } from "./test-support/held-witness";

// TC-2254 A2.3 (S14, S11 (f)): a wallet that declines is the recoverable SIGNATURE_REJECTED, the pending is kept, no OTP attempt is consumed and no mail
// is sent. The next acquireEmailProof with the same store resumes: R2, R5 (full S11 (a)), the wallet again, R6, R7, R8.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE = "alice@example.com";
const T0 = Date.parse("2026-10-30T06:53:00Z");

function world(declines: (call: number) => unknown = (call) => (call === 1 ? new Error("user declined") : undefined)) {
  const witness = createHeldWitness({ serverClock: () => T0 });
  const real = testAccountHolder(ANVIL_0);
  const wallet = { calls: 0, seen: [] as number[][] };
  const holder = { ...real, sign: async (bytes: Uint8Array) => { wallet.calls += 1; wallet.seen.push([...bytes]); const thrown = declines(wallet.calls); if (thrown !== undefined) throw thrown; return real.sign(bytes); } };
  const store = createMemoryEmailProofPendingStore();
  const now = () => new Date(T0);
  const run = () => acquireEmailProofWithIssuerKeys({ address: ALICE, holder, profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now, pendingStore: store, getCode: async () => "12345678" }, witness.issuerKeys);
  return { witness, holder, wallet, store, run, now };
}
async function failure(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}

describe("a wallet that declines, then signs", () => {
  test("1. the first acquireEmailProof is SIGNATURE_REJECTED, recoverable, and the pending is still in the store", async () => {
    const w = world();
    const error = await failure(w.run);
    expect([error?.code, error?.recoverable]).toEqual(["SIGNATURE_REJECTED", true]);
    expect(await w.store.findLive(ALICE, w.now())).toBeDefined();
  });

  test("2. the second acquireEmailProof resumes and issues: routes, one code mail, one proof attempt, two identical wallet prompts", async () => {
    const w = world();
    await failure(w.run);
    const before = w.witness.calls.length;
    const acquisition = await w.run();
    expect(acquisition.status).toBe("issued");
    const routes = w.witness.calls.slice(before).map((c) => c.route).filter((r) => r !== "state");
    expect(routes).toEqual(["catalog", "holder-binding", "holder-signature", "issue", "result"]);
    expect(w.witness.mails.filter((m) => m.kind === "code")).toHaveLength(1);
    expect(w.witness.mails.filter((m) => m.kind === "notice")).toHaveLength(1);
    expect([...w.witness.records.values()][0]!.attempts).toBe(1);
    expect(w.wallet.calls).toBe(2);
    expect(w.wallet.seen[1]).toEqual(w.wallet.seen[0]!);
    expect(await w.store.findLive(ALICE, w.now())).toBeUndefined();
  });

  test("3. a guard refusal keeps its code: an EmailProofError from the wallet is HOLDER_INVALID, not recoverable, and passes through", async () => {
    const w = world(() => new EmailProofError("request", "HOLDER_INVALID"));
    const error = await failure(w.run);
    expect([error?.code, error?.recoverable]).toEqual(["HOLDER_INVALID", false]);
    expect(w.wallet.calls).toBe(1);
  });

  test("4. an abort or a timeout from the wallet keeps its mapping (it is not SIGNATURE_REJECTED)", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const w = world(() => new DOMException("x", name));
      const error = await failure(w.run);
      expect(["SIGNATURE_REJECTED", "CODE_REJECTED"]).not.toContain(error?.code ?? "");
      expect(error?.code).toBe(name === "TimeoutError" ? "NETWORK" : "CANCELED");
    }
  });

  test("5. R6 answering 409 SIGNATURE_REPLAYED is SESSION_INVALID and the pending is deleted", async () => {
    const w = world(() => undefined);
    (w.witness.force as Record<string, unknown>)["holder-signature"] = { status: 409, body: { code: "SIGNATURE_REPLAYED", correlationId: "c", recoverable: false, state: "signature_replayed", type: "tinycloud.credentials/error/v1" } };
    const error = await failure(w.run);
    expect(error?.code).toBe("SESSION_INVALID");
    expect(await w.store.findLive(ALICE, w.now())).toBeUndefined();
  });
});
