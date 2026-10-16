// Bun source workload: never label these timings as built Node20 copy measurements.
import assert from 'node:assert/strict';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { KVService } from '../../sdk-services/src/kv/KVService.js';
import { SQLService } from '../../sdk-services/src/sql/SQLService.js';
import type { IServiceContext } from '../../sdk-services/src/types.js';
import type { OperationDefinition, RuntimeOperationContext } from '../../operations/src/contract.js';
import { appsOperationDefinitions, type ReadOutput, type QueryOutput } from '../../operations/src/operations/apps.js';
import { TC_APPS_ROOT as R, TC_APPS_DATABASE } from '../../operations/src/tc-apps.js';
import { diagnosticTelemetry, emitDiagnostic, makeDiagnosticContext, withDiagnosticContext } from '@tinycloud/operations/diagnostics';
import { capture, measure } from './diagnostics-measure-common.mjs';

assert(process.env.HOME?.includes('tc-diagnostics-measure-'));
const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { mode: string; records: number; result: string };
assert(Number.isInteger(config.records) && config.records >= 101 && config.records <= 1000);
const fixtureStart = performance.now();
const values = new Map<string, string>();
values.set(`${R}catalog/fitness`, JSON.stringify({ app: 'fitness', title: 'Synthetic', about: 'Fixture', created: '2026-10-14' }));
values.set(`${R}catalog/fitness/weight`, JSON.stringify({ app: 'fitness', kind: 'weight', about: 'Fixture', shape: 'log', per: 'time', v: 1, fields: { kg: 'number', note: 'text' }, created: '2026-10-14' }));
const keys = Array.from({ length: config.records }, (_, index) => `${R}fitness/weight/2026-10/2026-10-14T1200-synthetic-${String(index).padStart(4, '0')}`);
for (const [index, key] of keys.entries()) values.set(key, JSON.stringify({ v: 1, at: '2026-10-14', data: { kg: index, note: 'x'.repeat(512) }, by: 'synthetic' }));
const stale = `${R}index-stale/fitness/weight`;
values.set(stale, JSON.stringify({ since: '2026-10-14', by: 'synthetic' }));
const db = new Database(':memory:');
let sql_requests = 0, kv_requests = 0;
type Entry = { service: string; path: string; action: string };
// Synthetic authority is fixture-local, not a large JSON HTTP header. A full
// 100-member capability array exceeds Bun's default 16 KiB header ceiling.
const invocations = new Map<string, readonly Entry[]>();
let invocationSequence = 0;
function invocationHeaders(entries: readonly Entry[]): Record<string, string> {
  assert(invocations.size < 16, 'Synthetic invocation capacity exceeded');
  const id = String(++invocationSequence);
  invocations.set(id, entries);
  return { 'x-synthetic-invocation': id };
}
const transport: { service: string; action: string; items: number; status: number | null; error_name?: string }[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/invoke' || request.method !== 'POST') return new Response('Not found', { status: 404 });
  const id = request.headers.get('x-synthetic-invocation') ?? '';
  const entries = invocations.get(id);
  invocations.delete(id);
  assert(entries && entries.length > 0, 'Unknown synthetic invocation');
  if (entries[0]!.service === 'sql') {
    sql_requests++;
    const input = await request.json() as { action: string; sql: string; params: SQLQueryBindings[] };
    try {
      const statement = db.query(input.sql);
      if (input.action === 'query') {
        const rows = statement.values(...input.params);
        return Response.json({ columns: statement.columnNames, rows, rowCount: rows.length });
      }
      assert.equal(input.action, 'execute');
      const result = statement.run(...input.params);
      return Response.json({ changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) });
    } catch (error) {
      return Response.json({ error: { code: 'SQL_ERROR', message: error instanceof Error ? error.message : 'SQLite error' } }, { status: 400 });
    }
  }
  kv_requests++;
  const entry = entries[0]!;
  const text = values.get(entry.path);
  if (entry.action === 'tinycloud.kv/list') {
    const all = [...values.keys()].filter(key => key.startsWith(entry.path)).sort();
    const offset = Number(request.headers.get('x-tinycloud-cursor') ?? 0);
    const limit = Math.min(73, Number(request.headers.get('x-tinycloud-limit') ?? 73));
    const next = offset + limit < all.length ? String(offset + limit) : undefined;
    return Response.json(all.slice(offset, offset + limit), { headers: next ? { 'x-tinycloud-next-cursor': next, 'x-tinycloud-truncated': 'true' } : {} });
  }
  if (entry.action === 'tinycloud.kv/put') {
    assert(entries.every(value => value.service === 'kv' && value.action === 'tinycloud.kv/put'));
    // SDK batchPut always sends multipart, even for one member. Plain put
    // sends raw bytes/string and carries its conditional headers separately.
    if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await request.formData();
      assert.equal([...form.keys()].length, entries.length);
      const pending: [string, string][] = [];
      for (const value of entries) {
        const partName = encodeURIComponent(value.path).replace(/[!'()*]/g, character =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        const part = form.get(partName);
        assert(part instanceof Blob, 'Missing SDK batchPut value part');
        pending.push([value.path, await part.text()]);
      }
      for (const [key, stored] of pending) values.set(key, stored);
      return Response.json({ written: pending.map(([key]) => key), count: pending.length });
    }
    assert.equal(entries.length, 1, 'Non-multipart put must select one key');
    const etag = text === undefined ? undefined : `"${createHash('sha256').update(text).digest('hex')}"`;
    if ((request.headers.get('if-none-match') === '*' && text !== undefined) ||
        (request.headers.has('if-match') && request.headers.get('if-match') !== etag)) {
      return new Response('Conflict', { status: 412 });
    }
    const stored = await request.text();
    values.set(entry.path, stored);
    return new Response(null, { headers: { etag: `"${createHash('sha256').update(stored).digest('hex')}"` } });
  }
  if (entry.action === 'tinycloud.kv/del') {
    if (text === undefined) return new Response('Missing', { status: 404 });
    const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
    if (request.headers.has('if-match') && request.headers.get('if-match') !== etag) return new Response('Conflict', { status: 412 });
    values.delete(entry.path);
    return new Response(null, { status: 204 });
  }
  assert(entries.every(value => value.service === 'kv' && value.action === 'tinycloud.kv/get'));
  if (entries.length > 1) return Response.json({ results: entries.map(value => {
    const stored = values.get(value.path);
    return stored === undefined ? { key: value.path, ok: false, error: { code: 'KV_NOT_FOUND', message: 'Missing' } } : {
      key: value.path, ok: true, dataBase64: Buffer.from(stored).toString('base64'),
      headers: { 'content-type': 'application/json', etag: `"${createHash('sha256').update(stored).digest('hex')}"` },
    };
  }) });
  return text === undefined ? new Response('Missing', { status: 404 }) : new Response(text, { headers: { 'content-type': 'application/json', etag: `"${createHash('sha256').update(text).digest('hex')}"` } });
} });
const host = `http://127.0.0.1:${server.port}`;
const history = await capture(config.mode, process.env.TC_DIAGNOSTICS_HOME!, 'client');
const space = 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default';
const context: IServiceContext = {
  session: { delegationHeader: { Authorization: 'synthetic' }, delegationCid: 'synthetic', spaceId: space, verificationMethod: 'did:key:synthetic', jwk: {} },
  isAuthenticated: true, hosts: [host], diagnosticTelemetryEnabled: history.binding !== undefined,
  invoke: (_session, service, path, action) => invocationHeaders([{ service, path, action }]),
  invokeAny: (_session, entries) => invocationHeaders(entries),
  async fetch(url, init) {
    assert.equal(new URL(url).origin, host);
    const id = new Headers(init?.headers).get('x-synthetic-invocation') ?? '';
    const entries = invocations.get(id);
    assert(entries && entries.length > 0);
    const observation = { service: entries[0]!.service, action: entries[0]!.action, items: entries.length };
    try {
      const response = await fetch(url, init as RequestInit);
      transport.push({ ...observation, status: response.status });
      return response;
    } catch (error) {
      transport.push({ ...observation, status: null, error_name: error instanceof Error ? error.name : 'unknown' });
      throw error;
    } finally { invocations.delete(id); }
  },
  getService: () => undefined,
  emit: (name, data) => { diagnosticTelemetry.onEvent(name, data); },
  on: () => () => {}, abortSignal: new AbortController().signal,
  retryPolicy: { maxAttempts: 1, backoff: 'exponential', baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
};
const kv = new KVService({ prefix: '' }); kv.initialize(context);
const sql = new SQLService(); sql.initialize(context);
const operationContext: RuntimeOperationContext = {
  summary: { profile: 'synthetic', host, posture: 'delegate-session', space },
  runtime: { node: { kvForSpace: () => kv, sqlForSpace: () => sql }, granted: [{ service: 'tinycloud.sql', space, path: TC_APPS_DATABASE, actions: ['tinycloud.sql/read', 'tinycloud.sql/write', 'tinycloud.sql/schema'] }] },
};
const read = appsOperationDefinitions.find(value => value.id === 'tinycloud.apps.read') as OperationDefinition<unknown, ReadOutput>;
const query = appsOperationDefinitions.find(value => value.id === 'tinycloud.apps.query') as OperationDefinition<unknown, QueryOutput>;
const fixture_setup_ms = performance.now() - fixtureStart;
let largeReadEvidence: unknown = null;
let copyEvidence: unknown = null;
const scope = history.binding ? makeDiagnosticContext(history.binding, 'client') : undefined;
withDiagnosticContext(scope, () => emitDiagnostic({ type: 'invocation.start', activity: 'unknown' }));
try {
  const large_read = await measure(() => withDiagnosticContext(scope, () => read.execute(operationContext, { prefixes: [`${R}fitness/weight/`], keys: keys.slice(0, 100) })));
  largeReadEvidence = large_read;
  assert.equal(large_read.value.status, 'ok');
  if (large_read.value.status !== 'ok') throw new Error('Read did not complete');
  assert.deepEqual(large_read.value.output.records.map(value => 'value' in value ? value.value : null), keys.slice(0, 100).map(key => JSON.parse(values.get(key)!)));
  const copy_rebuild = await measure(() => withDiagnosticContext(scope, () => query.execute(operationContext, { kinds: [{ app: 'fitness', kind: 'weight' }], sql: "SELECT count(*) AS n, sum(json_extract(data, '$.kg')) AS total FROM entries" })));
  copyEvidence = copy_rebuild;
  assert.equal(copy_rebuild.value.status, 'ok');
  if (copy_rebuild.value.status !== 'ok') throw new Error('Copy did not complete');
  assert.deepEqual(copy_rebuild.value.output.rows, [[config.records, config.records * (config.records - 1) / 2]]);
  const copied = db.query<{ key: string; rec: string }, []>('SELECT key, rec FROM records ORDER BY key').all();
  assert.deepEqual(copied.map(value => [value.key, JSON.parse(value.rec)]), keys.map(key => [key, JSON.parse(values.get(key)!)]));
  assert.equal(values.has(stale), false);
  withDiagnosticContext(scope, () => emitDiagnostic({ type: 'invocation.finish', exit_code: 0, business: 'unknown' }));
  const diagnostic = await history.finish();
  await writeFile(config.result, JSON.stringify({
    runtime: { kind: 'source_consumer', bun: Bun.version, sqlite: db.query('SELECT sqlite_version() AS version').get() },
    completed: true, transport,
    fixture_setup_ms, large_read, copy_rebuild, diagnostic, dispatch: { kv_requests, sql_requests },
    business: { read: large_read.value, copy: copy_rebuild.value, copied, stale_marker_present: values.has(stale), kv_remaining: [...values.entries()] },
    limitations: ['Bun source operations and SDK services, not Node20 copy compatibility or timing.', 'Actual SQLite statements and real SDK loopback dispatch; synthetic invocation headers intentionally replace cryptographic authorization in this copy-only fixture.', 'No HTTP MCP boundary surrounds this direct actual apps operation workload; registered built MCP is measured separately.', 'Fresh empty SQLite and freshly seeded paginated KV per subprocess. No auth, human approval, replica cache or production network measurement.'],
  }), { mode: 0o600 });
} catch (error) {
  withDiagnosticContext(scope, () => emitDiagnostic({ type: 'invocation.finish', exit_code: 1, business: 'unknown' }));
  // Preserve the actual synthetic operation failure and dispatched response
  // classes before the parent removes this disposable sample directory.
  await writeFile(config.result, JSON.stringify({
    completed: false, runtime: { kind: 'source_consumer', bun: Bun.version },
    large_read: largeReadEvidence, copy_rebuild: copyEvidence, transport,
    dispatch: { kv_requests, sql_requests }, diagnostic_health: history.runtime.health(),
    failure: error instanceof Error ? error.message : 'Unknown fixture failure',
    limitations: ['Incomplete source workload; no output/effect parity or unobserved timing is asserted.'],
  }), { mode: 0o600 });
  throw error;
} finally { await history.runtime.close(); server.stop(true); db.close(); }
