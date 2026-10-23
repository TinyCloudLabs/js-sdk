import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import {
  CODE_GATE_PROFILE,
  EmailProofGateError,
  HeadlessReceiveError,
  PENDING_RECEIVE_MAX_AGE_MS,
  codeGateSource,
  completeHeadlessReceive,
  exactEmailRecipient,
  filePendingStore as createFilePendingStore,
  parseStoredEnvelope,
  promptHeadlessReceive,
  requestHeadlessCode,
  retryMinutes,
  selectCredentialSource,
  type EmailProofGate,
  type HeadlessReceiveErrorCode,
  type EmailProofMaterial,
  type ShareAccessPort,
} from "./headless-receive.js";
import { createFileEmailProofPendingStore } from "@tinycloud/node-sdk/credential-pending-store";
import { createNodeEmailProofGate, gateCodeFor, unavailableOpenAddressedShare, unavailablePresentationBuilder } from "./headless-receive-deps.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const RESUME = "0123456789abcdef0123456789abcdef";
const CODE = "24681357";
const ENVELOPE = { v: 3, recipient: "owner@example.com" } as unknown as ShareEnvelopeV3;

// Fixture envelopes are plain objects, so this store accepts them as-is. The production schema is exercised by the malformed-envelope test below.
const filePendingStore = (dir: string) => createFilePendingStore(dir, (value) => value as ShareEnvelopeV3);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp("/var/tmp/tc1757-receive-");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeGate(overrides: Partial<EmailProofGate> = {}): EmailProofGate {
  return {
    requestCode: async () => ({ state: { nonce: "n1" }, expiresAt: new Date(NOW + 600_000).toISOString() }),
    completeEmailProof: async ({ code }) => {
      if (code !== CODE) throw new EmailProofGateError("CODE_REJECTED", "bad code", undefined, true);
      return { holderDid: "did:key:z6Mk-test" } as unknown as EmailProofMaterial;
    },
    ...overrides,
  };
}

function fakeAccess(bytes = new TextEncoder().encode("# hello"), onReceive?: (envelope: unknown) => void): ShareAccessPort {
  return {
    receive: async (envelope) => {
      onReceive?.(envelope);
      return { bytes, filename: "share.md" };
    },
  };
}

async function expectHeadless(promise: Promise<unknown>, code: HeadlessReceiveErrorCode): Promise<HeadlessReceiveError> {
  const error = await promise.then(
    () => { throw new Error("expected HeadlessReceiveError"); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HeadlessReceiveError);
  expect((error as HeadlessReceiveError).code).toBe(code);
  return error as HeadlessReceiveError;
}

async function pendingFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".json"));
}

describe("requestHeadlessCode", () => {
  test("persists a 0600 pending file in a 0700 directory", async () => {
    const store = filePendingStore(dir);
    const result = await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate: fakeGate(), store, now: NOW, randomId: () => RESUME });
    expect(result.id).toBe(RESUME);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${RESUME}.json`))).mode & 0o777).toBe(0o600);
  });

  test("caps expiry at 15 minutes even when the witness grants longer", async () => {
    const store = filePendingStore(dir);
    const gate = fakeGate({ requestCode: async () => ({ state: {}, expiresAt: new Date(NOW + 86_400_000).toISOString() }) });
    const result = await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW, randomId: () => RESUME });
    expect(result.expiresAt).toBe(NOW + PENDING_RECEIVE_MAX_AGE_MS);
  });

  test("maps a rate-limited request to RATE_LIMITED with exit 6 and minutes to wait", async () => {
    const gate = fakeGate({
      requestCode: async () => { throw new EmailProofGateError("RATE_LIMITED", "429", 14 * 60_000 + 1); },
    });
    const error = await expectHeadless(
      requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store: filePendingStore(dir), now: NOW, randomId: () => RESUME }),
      "RATE_LIMITED",
    );
    expect(error.exitCode).toBe(6);
    expect(error.message).toBe("rate limited for this mailbox; try again in 15 minutes");
    expect(await pendingFiles()).toEqual([]);
  });

  test("a second request for the same share reuses the live pending and sends no new code", async () => {
    let sends = 0;
    const gate = fakeGate({ requestCode: async () => { sends += 1; return { state: {}, expiresAt: new Date(NOW + 600_000).toISOString() }; } });
    const store = filePendingStore(dir);
    const first = await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW, randomId: () => RESUME });
    const second = await requestHeadlessCode({
      envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW + 1000,
      randomId: () => { throw new Error("a reused pending must not mint an id"); },
    });
    expect(sends).toBe(1);
    expect(second).toEqual(first);
    expect(await pendingFiles()).toEqual([`${RESUME}.json`]);
  });

  test("a different share to the same mailbox gets its own code and never another share's id", async () => {
    const OTHER = "fedcba9876543210fedcba9876543210";
    let sends = 0;
    const gate = fakeGate({ requestCode: async () => { sends += 1; return { state: {}, expiresAt: new Date(NOW + 600_000).toISOString() }; } });
    const store = filePendingStore(dir);
    await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW, randomId: () => RESUME });
    const other = { v: 3, recipient: "other-share@example.com" } as unknown as ShareEnvelopeV3;
    const second = await requestHeadlessCode({ envelope: other, recipient: "owner@example.com", gate, store, now: NOW + 1000, randomId: () => OTHER });
    expect(sends).toBe(2);
    expect(second.id).toBe(OTHER);
  });

  test("an expired pending is not reused: the next request sends a new code", async () => {
    const OTHER = "fedcba9876543210fedcba9876543210";
    let sends = 0;
    const gate = fakeGate({ requestCode: async () => { sends += 1; return { state: {}, expiresAt: new Date(NOW + 86_400_000).toISOString() }; } });
    const store = filePendingStore(dir);
    await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW, randomId: () => RESUME });
    const second = await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store, now: NOW + PENDING_RECEIVE_MAX_AGE_MS, randomId: () => OTHER });
    expect(sends).toBe(2);
    expect(second.id).toBe(OTHER);
  });
});

describe("completeHeadlessReceive", () => {
  async function requestOne(): Promise<void> {
    await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate: fakeGate(), store: filePendingStore(dir), now: NOW, randomId: () => RESUME });
  }

  test("success returns bytes, passes the envelope through, and deletes the pending file", async () => {
    await requestOne();
    let received: unknown;
    const content = await completeHeadlessReceive({
      id: RESUME, code: CODE, gate: fakeGate(), store: filePendingStore(dir),
      access: fakeAccess(undefined, (envelope) => { received = envelope; }), now: NOW + 1000,
    });
    expect(new TextDecoder().decode(content.bytes)).toBe("# hello");
    expect(received).toEqual(ENVELOPE);
    expect(await pendingFiles()).toEqual([]);
  });

  test("wrong code is refused with exit 3, keeps the pending file, and never echoes the code", async () => {
    await requestOne();
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: "11111111", gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "CODE_REJECTED",
    );
    expect(error.exitCode).toBe(3);
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain("--resume");
    expect(error.message).not.toContain("11111111");
    expect(await pendingFiles()).toEqual([`${RESUME}.json`]);
  });

  test("after a wrong code, a retry with the correct code succeeds and then deletes the pending file", async () => {
    await requestOne();
    await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: "11111111", gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "CODE_REJECTED",
    );
    const bytes = await completeHeadlessReceive({ id: RESUME, code: CODE, gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + 2000 });
    expect(bytes).toBeDefined();
    expect(await pendingFiles()).toEqual([]);
  });

  test("malformed code is a usage error (exit 2) and keeps the pending file for the owner's retry", async () => {
    await requestOne();
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: "1234", gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "USAGE",
    );
    expect(error.exitCode).toBe(2);
    expect(await pendingFiles()).toEqual([`${RESUME}.json`]);
  });

  test("expired pending state is refused with exit 3 and deleted", async () => {
    await requestOne();
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + PENDING_RECEIVE_MAX_AGE_MS }),
      "REQUEST_EXPIRED",
    );
    expect(error.exitCode).toBe(3);
    expect(await pendingFiles()).toEqual([]);
  });

  test("unknown or traversal resume ids are refused without touching the filesystem", async () => {
    for (const id of ["../../etc/passwd", "short", RESUME.toUpperCase()]) {
      await expectHeadless(
        completeHeadlessReceive({ id, code: CODE, gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW }),
        "RESUME_NOT_FOUND",
      );
    }
  });

  test("node refusal maps to NODE_REFUSED with exit 7 and deletes state", async () => {
    await requestOne();
    const failing: ShareAccessPort = { receive: async () => { throw new Error("node said no"); } };
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate: fakeGate(), store: filePendingStore(dir), access: failing, now: NOW + 1000 }),
      "NODE_REFUSED",
    );
    expect(error.exitCode).toBe(7);
    expect(error.message).not.toContain("node said no");
    expect(await pendingFiles()).toEqual([]);
  });

  test("resume hands the gate the state saved at request time, read back from a fresh store", async () => {
    const gate = fakeGate({ requestCode: async () => ({ state: { requestId: "req-1" }, expiresAt: new Date(NOW + 600_000).toISOString() }) });
    await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate, store: filePendingStore(dir), now: NOW, randomId: () => RESUME });
    const seen: unknown[] = [];
    const resumed = fakeGate({
      completeEmailProof: async ({ state }) => {
        seen.push(state);
        return { holderDid: "did:key:z6Mk-test" } as unknown as EmailProofMaterial;
      },
    });
    await completeHeadlessReceive({ id: RESUME, code: CODE, gate: resumed, store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 });
    expect(seen).toEqual([{ requestId: "req-1" }]);
  });

  test("success hands the access port the envelope and the exact material the gate returned", async () => {
    await requestOne();
    const material = { holderDid: "did:key:z6Mk-test", holderSigner: { did: "did:key:z6Mk-test" }, credential: { credentialId: "c1" } } as unknown as EmailProofMaterial;
    const seen: unknown[] = [];
    const access: ShareAccessPort = {
      receive: async (envelope, received) => {
        seen.push({ envelope, received });
        return { bytes: new TextEncoder().encode("ok") };
      },
    };
    await completeHeadlessReceive({ id: RESUME, code: CODE, gate: fakeGate({ completeEmailProof: async () => material }), store: filePendingStore(dir), access, now: NOW + 1000 });
    expect(seen).toEqual([{ envelope: ENVELOPE, received: material }]);
  });

  test("a rate limit at completion keeps its wait, exits 6, and never shows the code", async () => {
    await requestOne();
    const gate = fakeGate({ completeEmailProof: async () => { throw new EmailProofGateError("RATE_LIMITED", `429 for ${CODE}`, 90_000); } });
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate, store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "RATE_LIMITED",
    );
    expect(error.exitCode).toBe(6);
    expect(error.retryAfterMs).toBe(90_000);
    expect(error.message).toBe("rate limited for this mailbox; try again in 2 minutes");
    expect(error.message).not.toContain(CODE);
    expect(await pendingFiles()).toEqual([]);
  });

  test("an unavailable credential service exits 6 and shows neither the gate detail nor the code", async () => {
    await requestOne();
    const gate = fakeGate({ completeEmailProof: async () => { throw new EmailProofGateError("UNAVAILABLE", `dns failure at witness.internal for ${CODE}`); } });
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate, store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "UNAVAILABLE",
    );
    expect(error.exitCode).toBe(6);
    expect(error.message).toBe("could not reach the credential service; try again later");
    expect(error.message).not.toContain("witness.internal");
    expect(error.message).not.toContain(CODE);
    expect(await pendingFiles()).toEqual([]);
  });

  test("a network failure at completion is recoverable: exits 6, keeps the pending file for a retry", async () => {
    await requestOne();
    const gate = fakeGate({ completeEmailProof: async () => { throw new EmailProofGateError("UNAVAILABLE", "dns failure at witness.internal", undefined, true); } });
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate, store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "UNAVAILABLE",
    );
    expect(error.exitCode).toBe(6);
    expect(error.message).not.toContain("witness.internal");
    expect(await pendingFiles()).toEqual([`${RESUME}.json`]);
  });

  test("a request the gate reports as expired exits 3 and deletes the pending file", async () => {
    await requestOne();
    const gate = fakeGate({ completeEmailProof: async () => { throw new EmailProofGateError("REQUEST_EXPIRED", "session gone"); } });
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: CODE, gate, store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "REQUEST_EXPIRED",
    );
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe("the code request expired; start again with --request-code");
    expect(await pendingFiles()).toEqual([]);
  });
});

describe("credential source seam", () => {
  test("selectCredentialSource returns the code-gate source for its profile and refuses others", () => {
    const source = codeGateSource(fakeGate());
    expect(selectCredentialSource(CODE_GATE_PROFILE, { [CODE_GATE_PROFILE]: source })).toBe(source);
    expect(() => selectCredentialSource("tinycloud.email-held/v1", { [CODE_GATE_PROFILE]: source })).toThrow(HeadlessReceiveError);
    try {
      selectCredentialSource("tinycloud.email-held/v1", { [CODE_GATE_PROFILE]: source });
    } catch (error) {
      expect((error as HeadlessReceiveError).code).toBe("UNSUPPORTED_PROFILE");
    }
  });

  test("code-gate find is empty until a credential is stored in-process for that recipient", async () => {
    const source = codeGateSource(fakeGate());
    expect(await source.find("owner@example.com")).toBeUndefined();
    const material = { holderDid: "did:key:z6Mk-test" } as unknown as EmailProofMaterial;
    await source.store("owner@example.com", material);
    expect(await source.find("owner@example.com")).toBe(material);
    expect(await source.find("other@example.com")).toBeUndefined();
  });

  test("interactive path prompts once, stores in-process, and opens the share with the envelope", async () => {
    const source = codeGateSource(fakeGate());
    const received: unknown[] = [];
    const content = await promptHeadlessReceive({
      envelope: ENVELOPE,
      recipient: "owner@example.com",
      source,
      promptForCode: async () => CODE,
      access: fakeAccess(undefined, (envelope) => received.push(envelope)),
    });
    expect(new TextDecoder().decode(content.bytes)).toBe("# hello");
    expect(received).toEqual([ENVELOPE]);
    expect(await source.find("owner@example.com")).toBeDefined();
  });
});

describe("retryMinutes", () => {
  test("rounds up and never reports zero", () => {
    expect(retryMinutes(undefined)).toBe(1);
    expect(retryMinutes(0)).toBe(1);
    expect(retryMinutes(60_000)).toBe(1);
    expect(retryMinutes(60_001)).toBe(2);
  });
});

describe("stored envelope and recipient", () => {
  test("production store refuses a stored envelope that fails the share schema and removes it", async () => {
    await requestHeadlessCode({ envelope: ENVELOPE, recipient: "owner@example.com", gate: fakeGate(), store: filePendingStore(dir), now: NOW, randomId: () => RESUME });
    await expectHeadless(createFilePendingStore(dir).load(RESUME, NOW + 1000), "RESUME_NOT_FOUND");
    expect(await readdir(dir)).toEqual([]);
  });

  test("the schema parser accepts nothing that is not a share envelope", () => {
    expect(parseStoredEnvelope(ENVELOPE)).toBeUndefined();
  });

  test("exact-email shares name the mailbox; other matchers are refused as unsupported", () => {
    const exact = { recipientMatcher: { kind: "exactEmail", value: "owner@example.com" } } as unknown as ShareEnvelopeV3;
    expect(exactEmailRecipient(exact)).toBe("owner@example.com");
    const domain = { recipientMatcher: { kind: "emailDomain", value: "example.com" } } as unknown as ShareEnvelopeV3;
    const refused = (() => {
      try { exactEmailRecipient(domain); return undefined; } catch (caught) { return caught; }
    })();
    expect(refused).toBeInstanceOf(HeadlessReceiveError);
    expect((refused as HeadlessReceiveError).code).toBe("UNSUPPORTED_PROFILE");
  });
});

describe("email-proof gate adapter", () => {
  test("node-sdk session and code failures map to gate codes the command can act on", () => {
    expect(gateCodeFor("RATE_LIMITED")).toBe("RATE_LIMITED");
    expect(gateCodeFor("CODE_REJECTED")).toBe("CODE_REJECTED");
    expect(gateCodeFor("CODE_INVALID")).toBe("CODE_REJECTED");
    expect(gateCodeFor("SESSION_EXPIRED")).toBe("REQUEST_EXPIRED");
    expect(gateCodeFor("CODE_ATTEMPTS_EXHAUSTED")).toBe("REQUEST_EXPIRED");
    expect(gateCodeFor("NETWORK")).toBe("UNAVAILABLE");
  });

  test("completing an unknown request id is refused as expired, not as a crash", async () => {
    const gate = createNodeEmailProofGate({ store: createFileEmailProofPendingStore({ home: dir }), now: () => new Date(NOW) });
    const failure = await gate.completeEmailProof({ state: { requestId: RESUME }, code: CODE }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(EmailProofGateError);
    expect((failure as EmailProofGateError).code).toBe("REQUEST_EXPIRED");
  });

  test("a discovery failure at the code request maps to UNAVAILABLE and stores no pending request", async () => {
    const store = createFileEmailProofPendingStore({ home: dir });
    let witnessCalls = 0;
    const fetch = Object.assign(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        witnessCalls += 1;
        return new Response("unavailable", { status: 503 });
      },
      { preconnect: (_url: string | URL, _options?: unknown): void => undefined },
    );
    const gate = createNodeEmailProofGate({ store, fetch, now: () => new Date(NOW) });
    const failure = await gate.requestCode({ recipient: "reader@example.com" }).then(() => undefined, (caught: unknown) => caught);
    expect(failure).toBeInstanceOf(EmailProofGateError);
    expect((failure as EmailProofGateError).code).toBe("UNAVAILABLE");
    expect(await store.findLive("reader@example.com", new Date(NOW))).toBeUndefined();
    expect(witnessCalls).toBeGreaterThan(0);
  });

  test("without a presentation builder or share opener, receive fails closed with a fixed message", async () => {
    const builderFailure = await unavailablePresentationBuilder({} as never).then(() => undefined, (caught: unknown) => caught);
    expect((builderFailure as HeadlessReceiveError).message).toBe("presentation builder unavailable");
    const openFailure = await unavailableOpenAddressedShare({} as never).then(() => undefined, (caught: unknown) => caught);
    expect(openFailure).toBeInstanceOf(HeadlessReceiveError);
    expect((openFailure as HeadlessReceiveError).code).toBe("UNAVAILABLE");
  });
});
