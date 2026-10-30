import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { createFileEmailProofPendingStore, PendingStoreError } from './credential-pending-store';
import {
  acquireEmailProofWithIssuerKeys,
  completeEmailProofWithIssuerKeys,
  createMemoryEmailProofPendingStore,
  EmailProofError,
  requestEmailProofCode,
  restoreEmailProofPending,
  type EmailProofPending,
  type EmailProofPendingStore,
} from './credentials/email-proof';
import { createHeldWitness, testAccountHolder } from './credentials/test-support/held-witness';

// TC-2254 addendum A1 (S18): every pending store the held path can use round-trips EVERY held pending field through put then findLive,
// including `serverExpiresAt` and the client-clock creation time. Ticket (did:key) files written before this change load unchanged, and a
// held record never loads as a ticket record or the reverse. NEW file: `credential-pending-store.test.ts` is not edited.
const HELD = 'tinycloud.email-held/v1' as const;
const TICKET = 'tinycloud.email-proof/v1' as const;
const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ALICE = 'alice@example.com';
const T0 = Date.parse('2026-10-30T06:53:00Z');

let root: string;
let home: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-held-'));
  home = path.join(root, 'profile');
  fs.mkdirSync(home, { mode: 0o700 });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const fileFor = (requestId: string): string => path.join(home, 'credentials', `pending-${createHash('sha256').update(requestId).digest('hex')}.json`);
const freshStore = () => createFileEmailProofPendingStore({ home });

function world(slowBy = 0) {
  const time = { server: T0 };
  const witness = createHeldWitness({ serverClock: () => time.server });
  const holder = testAccountHolder(ANVIL_0);
  const now = () => new Date(time.server - slowBy);
  const input = (extra: Record<string, unknown> = {}) => ({ address: ALICE, holder, profile: HELD, allowHeldProfile: true as const, fetch: witness.fetch, now, ...extra });
  return { witness, holder, now, input };
}

describe('a held pending survives the file store and a process restart', () => {
  test('put, then a fresh store instance finds it with serverExpiresAt, and completing it succeeds', async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input());
    expect(pending.serverExpiresAt).toBeDefined();
    await freshStore().put(pending);
    // "Restart": a new store instance over the same directory; the in-memory object is gone.
    const found = await freshStore().findLive(ALICE, w.now());
    expect(found?.serverExpiresAt).toBe(pending.serverExpiresAt);
    expect(found?.createdAt).toBe(pending.createdAt);
    expect(found?.expiresAt).toBe(pending.expiresAt);
    const result = await completeEmailProofWithIssuerKeys({ pending: found!, code: '12345678', holder: w.holder, fetch: w.witness.fetch, now: w.now, allowHeldProfile: true }, w.witness.issuerKeys);
    expect(result.envelope.profile.id).toBe(HELD);
    expect(w.witness.mails.map((m) => m.kind)).toEqual(['code', 'notice']);
  });

  test('acquire in a second process resumes the stored held pending: one code mail in total', async () => {
    const w = world();
    const first = await acquireEmailProofWithIssuerKeys(w.input({ pendingStore: freshStore() }), w.witness.issuerKeys);
    expect(first.status).toBe('code-requested');
    const second = await acquireEmailProofWithIssuerKeys(w.input({ pendingStore: freshStore(), getCode: async () => '12345678' }), w.witness.issuerKeys);
    expect(second.status).toBe('issued');
    expect(w.witness.mails.filter((m) => m.kind === 'code')).toHaveLength(1);
    expect(await freshStore().findLive(ALICE, w.now())).toBeUndefined();
  });

  test('the stored file holds no one-time code and no signature', async () => {
    const w = world();
    const pending = await requestEmailProofCode(w.input());
    await freshStore().put(pending);
    const text = fs.readFileSync(fileFor(pending.requestId), 'utf8');
    expect(text).not.toContain('12345678');
    expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['address', 'createdAt', 'descriptorDigest', 'expiresAt', 'holderDid', 'openerOrigin', 'profile', 'requestId', 'requirementDigest', 'serverExpiresAt', 'type', 'verifier', 'version']);
  });
});

/** The property names of `interface EmailProofPending`, read from the type itself so a field added later is seen. */
function pendingTypeKeys(): string[] {
  const file = path.join(import.meta.dir, 'credentials', 'email-proof.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'EmailProofPending') {
      for (const member of statement.members) if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) keys.push(member.name.text);
    }
  }
  return keys.sort();
}

/** One distinctive value per known pending field. A new field must get a value here AND be persisted, or a test below fails. */
const HELD_FIELD_VALUES: Record<string, string | number> = {
  type: 'TinyCloudEmailProofPending',
  version: 1,
  profile: HELD,
  address: 'bob@example.com',
  requestId: 'R'.repeat(32),
  verifier: 'V'.repeat(43),
  holderDid: 'did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  descriptorDigest: 'D'.repeat(43),
  requirementDigest: 'Q'.repeat(43),
  openerOrigin: 'https://localhost',
  createdAt: '2026-10-30T06:53:00.000Z',
  expiresAt: '2026-10-30T07:03:00.000Z',
  serverExpiresAt: '2026-10-30T07:03:01.000Z',
};

function heldPending(): EmailProofPending {
  return restoreEmailProofPending({ ...HELD_FIELD_VALUES } as unknown as EmailProofPending);
}

describe('the pending type is enumerated: every field of it is persisted', () => {
  test('the fixture has a value for every field of EmailProofPending (add the field here when the type gains one)', () => {
    expect(pendingTypeKeys()).toEqual(Object.keys(HELD_FIELD_VALUES).sort());
  });

  for (const [name, makeStore] of [
    ['the file store, across a fresh instance', () => [freshStore(), freshStore()] as const],
    ['the memory store', () => { const s = createMemoryEmailProofPendingStore(); return [s, s] as const; }],
  ] as [string, () => readonly [EmailProofPendingStore, EmailProofPendingStore]][]) {
    test(`${name}: put then findLive returns every field, and no field is dropped`, async () => {
      const [writer, reader] = makeStore();
      const pending = heldPending();
      await writer.put(pending);
      const found = await reader.findLive('bob@example.com', new Date('2026-10-30T06:54:00Z'));
      expect(found).toBeDefined();
      const visible = JSON.parse(JSON.stringify(found));
      for (const key of pendingTypeKeys()) {
        // `verifier` is a non-enumerable bearer secret: read it directly, the rest through JSON.
        const actual = key === 'verifier' ? (found as unknown as Record<string, unknown>)[key] : visible[key];
        expect([key, actual]).toEqual([key, HELD_FIELD_VALUES[key]]);
      }
    });
  }
});

describe('ticket files written before this change load unchanged', () => {
  // Byte for byte what the store wrote for a ticket pending at 0181683f: two-space JSON, a trailing newline, no `serverExpiresAt` key.
  const OLD_TICKET_FILE = JSON.stringify({
    type: 'TinyCloudEmailProofPending', version: 1, profile: TICKET, address: 'reader@example.com', requestId: 'old-request-0123456789abcdef', verifier: 'old-verifier-token',
    holderDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', descriptorDigest: 'D'.repeat(43), requirementDigest: 'Q'.repeat(43), openerOrigin: 'https://localhost',
    createdAt: '2026-10-30T06:53:00.000Z', expiresAt: '2026-10-30T07:03:00.000Z',
  }, null, 2) + '\n';

  test('a pre-change ticket file is read as before, with no serverExpiresAt', async () => {
    fs.mkdirSync(path.join(home, 'credentials'), { mode: 0o700 });
    fs.writeFileSync(fileFor('old-request-0123456789abcdef'), OLD_TICKET_FILE, { mode: 0o600 });
    const found = await freshStore().findLive('reader@example.com', new Date('2026-10-30T06:54:00Z'));
    expect(found?.profile).toBe(TICKET);
    expect(found?.requestId).toBe('old-request-0123456789abcdef');
    expect(found?.serverExpiresAt).toBeUndefined();
    expect((found as unknown as Record<string, unknown>).verifier).toBe('old-verifier-token');
  });

  test('a ticket pending is still written with exactly the old field list', async () => {
    const pending = restoreEmailProofPending({ ...JSON.parse(OLD_TICKET_FILE) } as EmailProofPending);
    await freshStore().put(pending);
    expect(fs.readFileSync(fileFor(pending.requestId), 'utf8')).toBe(OLD_TICKET_FILE);
  });
});

describe('a held record never loads as a ticket record, nor the reverse (fail closed)', () => {
  const held = () => ({ ...HELD_FIELD_VALUES }) as Record<string, unknown>;
  const writeRaw = (record: Record<string, unknown>) => {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fileFor(String(record.requestId)), JSON.stringify(record), { mode: 0o600 });
  };
  const bad: [string, Record<string, unknown>][] = [
    ['a held file without serverExpiresAt', Object.fromEntries(Object.entries(held()).filter(([k]) => k !== 'serverExpiresAt'))],
    ['a held file with a non-string serverExpiresAt', { ...held(), serverExpiresAt: 7 }],
    ['a held file with an unparseable serverExpiresAt', { ...held(), serverExpiresAt: 'not a time' }],
    ['a ticket file that carries serverExpiresAt', { ...held(), profile: TICKET, holderDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' }],
  ];
  for (const [name, record] of bad) {
    test(`${name} is refused as an invalid store file and deleted`, async () => {
      writeRaw(record);
      await expect(freshStore().findLive('bob@example.com', new Date('2026-10-30T06:54:00Z'))).rejects.toMatchObject({ code: 'credential-store-invalid' });
      expect(fs.existsSync(fileFor(String(record.requestId)))).toBe(false);
    });
  }

  test('put refuses a held pending that lacks serverExpiresAt, and a ticket pending that has one, before writing', async () => {
    const withoutField = restoreEmailProofPending({ ...held(), serverExpiresAt: undefined } as unknown as EmailProofPending);
    await expect(freshStore().put(withoutField)).rejects.toBeInstanceOf(PendingStoreError);
    const ticketWithField = restoreEmailProofPending({ ...held(), profile: TICKET } as unknown as EmailProofPending);
    await expect(freshStore().put(ticketWithField)).rejects.toBeInstanceOf(PendingStoreError);
    expect(fs.existsSync(path.join(home, 'credentials')) ? fs.readdirSync(path.join(home, 'credentials')).filter((n) => n.startsWith('pending-')) : []).toEqual([]);
  });
});

describe('a resumed held pending without a valid serverExpiresAt is refused before any prompt, request or mail', () => {
  test('acquire over a store that returns it without the field: SESSION_INVALID, no getCode, no new request', async () => {
    const w = world();
    const real = await requestEmailProofCode(w.input());
    const mailsBefore = w.witness.mails.length;
    const callsBefore = w.witness.calls.length;
    const lossy: EmailProofPendingStore = {
      async findLive() { const { serverExpiresAt: _dropped, ...rest } = JSON.parse(JSON.stringify(real)); return restoreEmailProofPending({ ...rest, verifier: (real as unknown as { verifier: string }).verifier }); },
      async put() {}, async delete() {}, async get() { return undefined; },
    };
    let asked = 0;
    const error = await acquireEmailProofWithIssuerKeys(w.input({ pendingStore: lossy, getCode: async () => { asked += 1; return '12345678'; } }), w.witness.issuerKeys).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailProofError);
    expect((error as EmailProofError).code).toBe('SESSION_INVALID');
    expect(asked).toBe(0);
    expect(w.witness.mails).toHaveLength(mailsBefore);
    expect(w.witness.calls).toHaveLength(callsBefore);
  });
});
