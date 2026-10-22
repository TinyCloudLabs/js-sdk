import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createFileEmailProofPendingStore,
  EMAIL_PROOF_PENDING_MAX_MS,
  PendingStoreError,
  type PendingRecord,
} from './credential-pending-store';

interface Record15 extends PendingRecord {
  readonly verifier: string;
}

let home: string;
let savedUmask: number;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'));
  savedUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(savedUmask);
  fs.rmSync(home, { recursive: true, force: true });
});

function record(requestId: string, address: string, expiresAt: Date): Record15 {
  return { requestId, address, expiresAt: expiresAt.toISOString(), verifier: `v-${requestId}` };
}

function fileFor(requestId: string): string {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return path.join(home, 'credentials', `pending-${digest}.json`);
}

const now = () => new Date();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe('createFileEmailProofPendingStore', () => {
  test('round-trips a record and keeps the verifier', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    const loaded = await store.load('reader@example.com', now());
    expect(loaded).toMatchObject({ requestId: 'R1', verifier: 'v-R1' });
  });

  test('writes the directory 0700 and the file 0600, even under a restrictive umask', async () => {
    process.umask(0o277);
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    expect(fs.statSync(path.join(home, 'credentials')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor('R1')).mode & 0o777).toBe(0o600);
  });

  test('keeps one live record per address: saving a new request replaces the old one', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    await store.save(record('R2', 'reader@example.com', inMinutes(10)));
    expect(fs.existsSync(fileFor('R1'))).toBe(false);
    expect(await store.load('reader@example.com', now())).toMatchObject({ requestId: 'R2' });
  });

  test('does not touch another address when saving', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'a@example.com', inMinutes(10)));
    await store.save(record('R2', 'b@example.com', inMinutes(10)));
    expect(await store.load('a@example.com', now())).toMatchObject({ requestId: 'R1' });
  });

  test('returns undefined for an unknown address', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    expect(await store.load('nobody@example.com', now())).toBeUndefined();
  });

  test('an expired record is deleted on read and not returned', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await store.load('reader@example.com', later)).toBeUndefined();
    expect(fs.existsSync(fileFor('R1'))).toBe(false);
  });

  test('refuses to save a record that expires beyond the 15-minute window', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    const tooLong = new Date(Date.now() + EMAIL_PROOF_PENDING_MAX_MS + 60_000);
    await expect(store.save(record('R1', 'reader@example.com', tooLong))).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('R1'))).toBe(false);
  });

  test('a file that expires beyond the window is rejected on read and deleted', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    const forged = record('R1', 'reader@example.com', new Date(Date.now() + 24 * 3600_000));
    fs.writeFileSync(fileFor('R1'), JSON.stringify(forged), { mode: 0o600 });
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('R1'))).toBe(false);
  });

  test('a file whose name does not match its request id is rejected and deleted', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    fs.renameSync(fileFor('R1'), fileFor('R2'));
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('R2'))).toBe(false);
  });

  test('two live records for one address are corruption: both are deleted and load fails', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true });
    fs.writeFileSync(fileFor('R2'), JSON.stringify(record('R2', 'reader@example.com', inMinutes(10))), { mode: 0o600 });
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('R1'))).toBe(false);
    expect(fs.existsSync(fileFor('R2'))).toBe(false);
  });

  test('malformed JSON is reported as invalid, not as a parse crash', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    fs.writeFileSync(fileFor('R1'), '{ not json', { mode: 0o600 });
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-store-invalid' });
  });

  test('a group-readable file is refused and left in place', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    fs.chmodSync(fileFor('R1'), 0o644);
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-permissions' });
    expect(fs.existsSync(fileFor('R1'))).toBe(true);
  });

  test('a symlinked pending file is refused', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    const target = path.join(home, 'elsewhere.json');
    fs.renameSync(fileFor('R1'), target);
    fs.symlinkSync(target, fileFor('R1'));
    await expect(store.load('reader@example.com', now())).rejects.toBeInstanceOf(PendingStoreError);
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a hard-linked pending file is refused', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    fs.linkSync(fileFor('R1'), path.join(home, 'second-link.json'));
    await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a symlinked profile directory is refused on save and load', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-real-'));
    const link = path.join(os.tmpdir(), `pending-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(real, link);
    try {
      const store = createFileEmailProofPendingStore<Record15>({ home: link });
      await expect(store.save(record('R1', 'reader@example.com', inMinutes(10)))).rejects.toMatchObject({ code: 'credential-permissions' });
      await expect(store.load('reader@example.com', now())).rejects.toMatchObject({ code: 'credential-permissions' });
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  test('a stale temp file from a killed writer is swept on read; a fresh one is kept', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await store.save(record('R1', 'reader@example.com', inMinutes(10)));
    const digest = createHash('sha256').update('R9').digest('hex');
    const stale = path.join(home, 'credentials', `pending-${digest}.json.123.aaaaaaaaaaaa.tmp`);
    const fresh = path.join(home, 'credentials', `pending-${digest}.json.124.bbbbbbbbbbbb.tmp`);
    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    fs.writeFileSync(fresh, '{}', { mode: 0o600 });
    const old = new Date(Date.now() - EMAIL_PROOF_PENDING_MAX_MS - 60_000);
    fs.utimesSync(stale, old, old);
    await store.load('reader@example.com', now());
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test('delete removes the record so a later load finds nothing', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    const pending = record('R1', 'reader@example.com', inMinutes(10));
    await store.save(pending);
    await store.delete(pending);
    expect(await store.load('reader@example.com', now())).toBeUndefined();
  });

  test('delete on an empty store is a no-op', async () => {
    const store = createFileEmailProofPendingStore<Record15>({ home });
    await expect(store.delete(record('R1', 'reader@example.com', inMinutes(10)))).resolves.toBeUndefined();
  });
});
