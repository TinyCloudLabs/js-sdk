import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { format, inspect } from 'node:util';
import { createFileEmailProofPendingStore, PendingStoreError, storedSecret } from './credential-pending-store';
import { restoreEmailProofPending, type EmailProofPending } from './credentials/email-proof';

const MINUTE = 60_000;

let root: string;
let home: string;
let savedUmask: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'));
  home = path.join(root, 'profile');
  fs.mkdirSync(home, { mode: 0o700 });
  savedUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(savedUmask);
  fs.rmSync(root, { recursive: true, force: true });
});

function dirOf(): string {
  return path.join(home, 'credentials');
}

function fileFor(requestId: string): string {
  return path.join(dirOf(), `pending-${createHash('sha256').update(requestId).digest('hex')}.json`);
}

function fieldsOf(requestId: string, address: string, createdAt: Date, ttlMs = 15 * MINUTE) {
  return {
    type: 'TinyCloudEmailProofPending' as const,
    version: 1 as const,
    profile: 'tinycloud.email-proof/v1' as const,
    address,
    requestId,
    verifier: `verifier-${requestId}`,
    holderDid: 'did:key:z6MkTest',
    descriptorDigest: 'descriptor-digest',
    requirementDigest: 'requirement-digest',
    openerOrigin: 'https://app.example',
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
}

function pendingFor(requestId: string, address: string, createdAt: Date, ttlMs?: number): EmailProofPending {
  return restoreEmailProofPending(fieldsOf(requestId, address, createdAt, ttlMs));
}

/** Writes a raw owner-only record, bypassing `put`, to simulate a hostile or damaged file. */
function writeRaw(file: string, content: string): void {
  fs.mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const store = () => createFileEmailProofPendingStore({ home });

describe('file pending store: round-trip and resume', () => {
  test('a resumed record keeps the verifier, so completion can use it', async () => {
    const now = new Date();
    await store().put(pendingFor('req-1', 'a@example.com', now));
    const resumed = await store().get('req-1', now);
    expect(resumed?.verifier).toBe('verifier-req-1');
    const found = await store().findLive('a@example.com', now);
    expect(found?.verifier).toBe('verifier-req-1');
  });

  test('the optional secret round-trips and is written 0600 in the file', async () => {
    const now = new Date();
    await store().put(pendingFor('req-s', 'a@example.com', now), { secret: new Uint8Array([1, 2, 3, 250]) });
    const resumed = await store().get('req-s', now);
    expect(storedSecret(resumed!)).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(fs.statSync(fileFor('req-s')).mode & 0o777).toBe(0o600);
  });

  test('a resumed record is redacted in JSON.stringify, spread, util.inspect, and console.log', async () => {
    const now = new Date();
    await store().put(pendingFor('req-r', 'a@example.com', now), { secret: new Uint8Array([9, 9, 9]) });
    const resumed = (await store().get('req-r', now))!;

    expect(JSON.stringify(resumed)).not.toContain('verifier-req-r');
    expect(JSON.stringify(resumed)).not.toContain('"verifier"');
    expect(Object.keys({ ...resumed })).not.toContain('verifier');
    expect(({ ...resumed } as Record<string, unknown>).verifier).toBeUndefined();
    expect(inspect(resumed)).not.toContain('verifier-req-r');
    expect(inspect(resumed)).toContain('[redacted]');

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(format(...args));
    };
    try {
      console.log(resumed);
    } finally {
      console.log = original;
    }
    expect(lines.join('\n')).not.toContain('verifier-req-r');
  });

  test('an unrelated secret is not visible through JSON or inspect', async () => {
    const now = new Date();
    await store().put(pendingFor('req-x', 'a@example.com', now), { secret: new Uint8Array([7, 7, 7, 7]) });
    const resumed = (await store().get('req-x', now))!;
    const secretB64 = Buffer.from([7, 7, 7, 7]).toString('base64');
    expect(JSON.stringify(resumed)).not.toContain(secretB64);
    expect(inspect(resumed)).not.toContain(secretB64);
  });
});

describe('file pending store: addressing and expiry', () => {
  test('two live records for one address: findLive returns the newest by createdAt', async () => {
    const now = new Date();
    await store().put(pendingFor('older', 'a@example.com', new Date(now.getTime() - 5 * MINUTE)));
    await store().put(pendingFor('newer', 'a@example.com', new Date(now.getTime() - 1 * MINUTE)));
    const found = await store().findLive('a@example.com', now);
    expect(found?.requestId).toBe('newer');
    expect(await store().get('older', now)).toBeDefined();
  });

  test('findLive ignores other addresses', async () => {
    const now = new Date();
    await store().put(pendingFor('req-a', 'a@example.com', now));
    expect(await store().findLive('b@example.com', now)).toBeUndefined();
  });

  test('the file name contains a hash of the request id and no address', async () => {
    await store().put(pendingFor('req-n', 'secret-person@example.com', new Date()));
    const names = fs.readdirSync(dirOf());
    expect(names).toEqual([path.basename(fileFor('req-n'))]);
    expect(names[0]).not.toContain('secret-person');
    expect(names[0]).toMatch(/^pending-[0-9a-f]{64}\.json$/);
  });

  test('an expired record is excluded and deleted on read', async () => {
    const now = new Date();
    await store().put(pendingFor('req-old', 'a@example.com', new Date(now.getTime() - 20 * MINUTE)));
    expect(await store().findLive('a@example.com', now)).toBeUndefined();
    expect(fs.existsSync(fileFor('req-old'))).toBe(false);
  });

  test('a record whose expiry passes is deleted once that time is reached', async () => {
    const created = new Date();
    await store().put(pendingFor('req-10', 'a@example.com', created, 10 * MINUTE));
    expect(await store().findLive('a@example.com', new Date(created.getTime() + 11 * MINUTE))).toBeUndefined();
    expect(fs.existsSync(fileFor('req-10'))).toBe(false);
  });

  test('put refuses a record that expires beyond the 15-minute window', async () => {
    await expect(store().put(pendingFor('req-16', 'a@example.com', new Date(), 16 * MINUTE))).rejects.toMatchObject({
      code: 'credential-store-invalid',
    });
  });

  test('a file on disk that expires beyond the window is invalid on read and is deleted', async () => {
    const created = new Date();
    writeRaw(fileFor('req-16'), JSON.stringify(fieldsOf('req-16', 'a@example.com', created, 16 * MINUTE), null, 2));
    await expect(store().findLive('a@example.com', created)).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('req-16'))).toBe(false);
  });

  test('a record with a file name that does not match its request id is invalid and deleted', async () => {
    const created = new Date();
    writeRaw(fileFor('other-id'), JSON.stringify(fieldsOf('req-mismatch', 'a@example.com', created), null, 2));
    await expect(store().get('other-id', created)).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('other-id'))).toBe(false);
  });

  test('a record without a verifier is invalid and deleted', async () => {
    const created = new Date();
    const { verifier: _omit, ...withoutVerifier } = fieldsOf('req-nv', 'a@example.com', created);
    writeRaw(fileFor('req-nv'), JSON.stringify(withoutVerifier));
    await expect(store().get('req-nv', created)).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('req-nv'))).toBe(false);
  });

  test('malformed JSON is reported as invalid and deleted', async () => {
    writeRaw(fileFor('req-bad'), '{not json');
    await expect(store().get('req-bad', new Date())).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('req-bad'))).toBe(false);
  });

  test('a malformed pending file fails findLive with credential-store-invalid, is removed, and the store recovers', async () => {
    const now = new Date();
    await store().put(pendingFor('req-good', 'a@example.com', now));
    fs.writeFileSync(fileFor('req-broken'), '{"type":"TinyCloudEmailProofPending"', { mode: 0o600 });
    await expect(store().findLive('zz@example.com', now)).rejects.toMatchObject({ code: 'credential-store-invalid' });
    expect(fs.existsSync(fileFor('req-broken'))).toBe(false);
    expect(await store().findLive('a@example.com', now)).toMatchObject({ requestId: 'req-good' });
  });

  test('__proto__ keys in a record are ignored and do not pollute prototypes', async () => {
    const created = new Date();
    const hostile = { ...fieldsOf('req-proto', 'a@example.com', created), ['__proto__']: { polluted: true } };
    writeRaw(fileFor('req-proto'), JSON.stringify(hostile));
    const got = (await store().get('req-proto', created))!;
    expect(got.requestId).toBe('req-proto');
    expect((got as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('file pending store: owner-only storage', () => {
  test('writes the directory 0700 and the file 0600 even under a restrictive umask on a fresh home', async () => {
    const fresh = path.join(root, 'fresh-profile');
    process.umask(0o277);
    await createFileEmailProofPendingStore({ home: fresh }).put(pendingFor('req-u', 'a@example.com', new Date()));
    expect(fs.statSync(path.join(fresh, 'credentials')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(fresh, 'credentials', path.basename(fileFor('req-u')))).mode & 0o777).toBe(0o600);
  });

  test('permissions are re-checked on every read, not cached', async () => {
    const now = new Date();
    await store().put(pendingFor('req-p', 'a@example.com', now));
    expect((await store().get('req-p', now))?.requestId).toBe('req-p');
    fs.chmodSync(fileFor('req-p'), 0o644);
    await expect(store().get('req-p', now)).rejects.toMatchObject({ code: 'credential-permissions' });
    fs.chmodSync(fileFor('req-p'), 0o600);
    expect((await store().get('req-p', now))?.requestId).toBe('req-p');
  });

  test('group- or world-readable files are refused and left in place', async () => {
    const now = new Date();
    for (const mode of [0o640, 0o644]) {
      await store().put(pendingFor('req-m', 'a@example.com', now));
      fs.chmodSync(fileFor('req-m'), mode);
      await expect(store().get('req-m', now)).rejects.toMatchObject({ code: 'credential-permissions' });
      expect(fs.existsSync(fileFor('req-m'))).toBe(true);
    }
  });

  test('group- or world-accessible directories are refused', async () => {
    const now = new Date();
    await store().put(pendingFor('req-d', 'a@example.com', now));
    for (const mode of [0o750, 0o755]) {
      fs.chmodSync(dirOf(), mode);
      await expect(store().findLive('a@example.com', now)).rejects.toMatchObject({ code: 'credential-permissions' });
    }
  });

  test('a symlinked pending file (live or dangling) is refused', async () => {
    const now = new Date();
    fs.mkdirSync(dirOf(), { mode: 0o700 });
    const real = path.join(home, 'real.json');
    await store().put(pendingFor('req-real', 'a@example.com', now));
    fs.renameSync(fileFor('req-real'), real);
    fs.symlinkSync(real, fileFor('req-sym'));
    await expect(store().get('req-sym', now)).rejects.toMatchObject({ code: 'credential-permissions' });
    fs.rmSync(fileFor('req-sym'));
    fs.symlinkSync(path.join(home, 'missing.json'), fileFor('req-dangle'));
    await expect(store().get('req-dangle', now)).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a hard-linked pending file is refused', async () => {
    const now = new Date();
    await store().put(pendingFor('req-h', 'a@example.com', now));
    fs.linkSync(fileFor('req-h'), path.join(home, 'second-link.json'));
    await expect(store().get('req-h', now)).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a symlinked credentials directory is refused on save and load', async () => {
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, dirOf());
    await expect(store().put(pendingFor('req-sd', 'a@example.com', new Date()))).rejects.toMatchObject({
      code: 'credential-permissions',
    });
    await expect(store().findLive('a@example.com', new Date())).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a symlinked home is refused', async () => {
    const link = path.join(root, 'home-link');
    fs.symlinkSync(home, link);
    await expect(createFileEmailProofPendingStore({ home: link }).put(pendingFor('req-sh', 'a@example.com', new Date()))).rejects.toMatchObject({
      code: 'credential-permissions',
    });
  });

  test('a home below a symlinked ancestor is refused', async () => {
    const parentLink = path.join(root, 'parent-link');
    fs.symlinkSync(root, parentLink);
    const underLink = path.join(parentLink, 'profile');
    await expect(createFileEmailProofPendingStore({ home: underLink }).put(pendingFor('req-an', 'a@example.com', new Date()))).rejects.toMatchObject({
      code: 'credential-permissions',
    });
  });

  test('a relative or empty home is refused at construction', () => {
    expect(() => createFileEmailProofPendingStore({ home: 'relative/profile' })).toThrow(PendingStoreError);
    expect(() => createFileEmailProofPendingStore({ home: '' })).toThrow(PendingStoreError);
  });

  test('a non-regular file at the record path is not replaced', async () => {
    fs.mkdirSync(fileFor('req-dir'), { recursive: true, mode: 0o700 });
    await expect(store().put(pendingFor('req-dir', 'a@example.com', new Date()))).rejects.toMatchObject({
      code: 'credential-permissions',
    });
  });

  test('a stale temp file from a killed writer is swept on read; a fresh one is kept', async () => {
    const now = new Date();
    await store().put(pendingFor('req-keep', 'a@example.com', now));
    const stale = `${fileFor('req-stale')}.123.abcdef012345.tmp`;
    const fresh = `${fileFor('req-fresh')}.456.fedcba543210.tmp`;
    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    fs.writeFileSync(fresh, '{}', { mode: 0o600 });
    const old = new Date(now.getTime() - 20 * MINUTE);
    fs.utimesSync(stale, old, old);
    await store().findLive('a@example.com', now);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test('concurrent saves of different requests all persist', async () => {
    const now = new Date();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store().put(pendingFor(`c-${i}`, 'a@example.com', now))));
    for (let i = 0; i < 20; i++) {
      expect((await store().get(`c-${i}`, now))?.requestId).toBe(`c-${i}`);
    }
  });

  test('delete removes the record; deleting a missing record is a no-op', async () => {
    const now = new Date();
    await store().put(pendingFor('req-del', 'a@example.com', now));
    await store().delete('req-del');
    expect(await store().get('req-del', now)).toBeUndefined();
    await expect(store().delete('never-stored')).resolves.toBeUndefined();
  });

  test('a store path that is not a directory is refused by put, get, findLive, and delete', async () => {
    const now = new Date();
    fs.writeFileSync(dirOf(), 'not a directory', { mode: 0o600 });
    const store = createFileEmailProofPendingStore({ home });
    await expect(store.put(pendingFor('req-file', 'a@example.com', now))).rejects.toMatchObject({ code: 'credential-permissions' });
    await expect(store.get('req-file', now)).rejects.toMatchObject({ code: 'credential-permissions' });
    await expect(store.findLive('a@example.com', now)).rejects.toMatchObject({ code: 'credential-permissions' });
    await expect(store.delete('req-file')).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('put refuses to replace a pending path that is not a regular file', async () => {
    const now = new Date();
    const store = createFileEmailProofPendingStore({ home });
    const pending = pendingFor('req-dest', 'a@example.com', now);
    await store.put(pending);
    fs.rmSync(fileFor('req-dest'));
    fs.mkdirSync(fileFor('req-dest'), { mode: 0o700 });
    await expect(store.put(pending)).rejects.toMatchObject({ code: 'credential-permissions' });
  });

  test('a stored pending file and its directory are owner-only, whatever the umask', async () => {
    process.umask(0o000);
    await createFileEmailProofPendingStore({ home }).put(pendingFor('req-mode', 'a@example.com', new Date()));
    expect(fs.statSync(fileFor('req-mode')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirOf()).mode & 0o777).toBe(0o700);
  });

  test('a pending resumed from the file store hides its verifier from JSON, spread, inspect, and console', async () => {
    const now = new Date();
    const store = createFileEmailProofPendingStore({ home });
    await store.put(pendingFor('req-redact', 'a@example.com', now));
    const found = await store.findLive('a@example.com', now);
    const byId = await store.get('req-redact', now);
    expect(found).toBeDefined();
    expect(byId).toBeDefined();
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(format(...args)); };
    try { console.log(found); } finally { console.log = original; }
    expect(inspect(found)).toContain('req-redact');
    expect(logged.join('\n')).toContain('req-redact');
    for (const surface of [JSON.stringify(found), JSON.stringify({ ...found }), JSON.stringify(byId), inspect(found), inspect(byId), ...logged]) {
      expect(surface).not.toContain('verifier-req-redact');
    }
  });
});
