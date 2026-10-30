import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileEmailProofPendingStore } from './credential-pending-store';
import { acquireEmailProofWithIssuerKeys, EmailProofError } from './credentials/email-proof';
import { createHeldWitness, testAccountHolder, type HeldWitnessOptions } from './credentials/test-support/held-witness';

// TC-2254 A2.1(a): the fix adds no new secret to any pending store. A held pending file holds exactly the ten text fields, `type`, `version` and the
// non-secret `serverExpiresAt`: never the one-time code, the holder signature, the binding, the credential, wallet material or the opt-in, and no
// `secret`. A pin, not RED: it goes RED if a later change adds `challengeNonce`, the binding or the code.
const HELD = 'tinycloud.email-held/v1' as const;
const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const T0 = Date.parse('2026-10-30T06:53:00Z');
const CODE = '12345678';
const TEN_TEXT_FIELDS = ['address', 'createdAt', 'descriptorDigest', 'expiresAt', 'holderDid', 'openerOrigin', 'profile', 'requestId', 'requirementDigest', 'verifier'];

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join('/var/tmp', 'held-fields-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** One held request that stops with a recoverable failure that keeps the pending, persisted with the file store. */
async function persistedAfter(options: Omit<HeldWitnessOptions, 'serverClock'>, walletDeclines: boolean) {
  const witness = createHeldWitness({ ...options, serverClock: () => T0 });
  const real = testAccountHolder(ANVIL_0);
  const signatures: string[] = [];
  const holder = {
    ...real,
    sign: async (bytes: Uint8Array) => {
      if (walletDeclines) throw new Error('user declined');
      const signature = await real.sign(bytes);
      signatures.push(Buffer.from(signature).toString('hex'));
      return signature;
    },
  };
  const store = createFileEmailProofPendingStore({ home: root });
  const error = await acquireEmailProofWithIssuerKeys(
    { address: 'alice@example.com', holder, profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now: () => new Date(T0), pendingStore: store, getCode: async () => CODE },
    witness.issuerKeys,
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmailProofError);
  expect((error as EmailProofError).recoverable).toBe(true);
  const files = fs.readdirSync(path.join(root, 'credentials')).filter((n) => n.startsWith('pending-'));
  expect(files).toHaveLength(1);
  const file = path.join(root, 'credentials', files[0]!);
  return { raw: fs.readFileSync(file, 'utf8'), signatures };
}

describe('a held pending file adds no new secret', () => {
  for (const [name, options, declines] of [
    ['after a declined wallet prompt (SIGNATURE_REJECTED, pending kept)', {}, true],
    ['after an accepted signature and a failed notice (ISSUER_UNAVAILABLE, pending kept)', { failNotice: 1 }, false],
  ] as const) {
    test(name, async () => {
      const { raw, signatures } = await persistedAfter(options, declines);
      const record = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([...TEN_TEXT_FIELDS, 'serverExpiresAt', 'type', 'version'].sort());
      expect(record.secret).toBeUndefined();
      expect(raw).not.toContain(CODE);
      expect(raw).not.toContain('credentialLifetimeSeconds');
      expect(raw).not.toContain('challengeNonce');
      for (const signature of signatures) expect(raw).not.toContain(signature);
      expect(raw).not.toMatch(/allowHeldProfile|0x[0-9a-fA-F]{130}/);
      expect(record.profile).toBe(HELD);
    });
  }
});
