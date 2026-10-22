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
      if (code !== CODE) throw new EmailProofGateError("CODE_REJECTED", "bad code");
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

  test("wrong code is refused with exit 3, deletes state, and never echoes the code", async () => {
    await requestOne();
    const error = await expectHeadless(
      completeHeadlessReceive({ id: RESUME, code: "11111111", gate: fakeGate(), store: filePendingStore(dir), access: fakeAccess(), now: NOW + 1000 }),
      "CODE_REJECTED",
    );
    expect(error.exitCode).toBe(3);
    expect(error.message).not.toContain("11111111");
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

  test("without a presentation builder or share opener, receive fails closed with a fixed message", async () => {
    const builderFailure = await unavailablePresentationBuilder({} as never).then(() => undefined, (caught: unknown) => caught);
    expect((builderFailure as HeadlessReceiveError).message).toBe("presentation builder unavailable");
    const openFailure = await unavailableOpenAddressedShare({} as never).then(() => undefined, (caught: unknown) => caught);
    expect(openFailure).toBeInstanceOf(HeadlessReceiveError);
    expect((openFailure as HeadlessReceiveError).code).toBe("UNAVAILABLE");
  });
});
