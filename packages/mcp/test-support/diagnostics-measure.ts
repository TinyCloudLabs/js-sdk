#!/usr/bin/env bun
/**
 * Reproducible private diagnostic workload comparison (never run tests/cli/setup.ts).
 * From SDK root after the parent builds:
 * bun packages/mcp/test-support/diagnostics-measure.ts --node20 /absolute/node20 --wrapper /absolute/tc-wrapper.sh --quick
 * Omit --quick for defaults (3 samples, 8 repeated MCP calls, 205 copy records).
 * Bounded overrides: --samples 1..10 --calls 1..100 --records 101..1000.
 * Requires Linux GNU /usr/bin/time and the already-built operations/node-sdk/CLI/MCP.
 * Results are private JSON in a newly created /tmp directory. Only its path is printed.
 * No installation, ambient profile, owner record, real approval or non-loopback access.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const options: Record<string, string> = {};
let quick = false;
for (let index = 0; index < argv.length; index++) {
  const key = argv[index]!;
  if (key === '--quick') { quick = true; continue; }
  assert(['--node20', '--wrapper', '--samples', '--calls', '--records'].includes(key), `Unknown option ${key}`);
  assert(argv[index + 1] && !argv[index + 1]!.startsWith('--'), `Missing ${key}`);
  assert(options[key] === undefined, `Duplicate ${key}`);
  options[key] = argv[++index]!;
}
const node20 = options['--node20'];
const wrapperSource = options['--wrapper'];
assert(node20 && isAbsolute(node20), '--node20 must name the real absolute Node20 executable');
assert(wrapperSource && isAbsolute(wrapperSource), '--wrapper must name the reviewed wrapper source');
const samples = Number(options['--samples'] ?? (quick ? 1 : 3));
const calls = Number(options['--calls'] ?? (quick ? 2 : 8));
const records = Number(options['--records'] ?? (quick ? 101 : 205));
assert(Number.isInteger(samples) && samples >= 1 && samples <= 10);
assert(Number.isInteger(calls) && calls >= 1 && calls <= 100);
assert(Number.isInteger(records) && records >= 101 && records <= 1000);
assert.equal(process.platform, 'linux', 'GNU time RSS units here are Linux KiB');
const sdk = resolve(import.meta.dir, '../../..');
const cli = join(sdk, 'packages/cli/bin/tc');
await Promise.all([access(node20), access(wrapperSource), access('/usr/bin/time'), access(cli), access(join(sdk, 'packages/mcp/dist/server.js'))]);
const root = await mkdtemp(join(tmpdir(), 'tc-diagnostics-measure-'));
await mkdir(join(root, 'bootstrap'), { mode: 0o700 });
// Deliberately discard ambient TC_*, NODE_OPTIONS, proxy, credential and client state.
const environment: Record<string, string> = {
  HOME: join(root, 'bootstrap'), TC_HOME: join(root, 'bootstrap/profiles'),
  TC_DIAGNOSTICS_HOME: join(root, 'bootstrap/history'),
  PATH: `${dirname(node20)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
process.umask(0o077);
const [{ createHermeticEncryptedNode }, state] = await Promise.all([
  import('../../node-sdk/src/test-support/hermetic-encrypted-node.js'), import('@tinycloud/operations/state'),
]);
interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; parent_wall_ms: number }
async function run(command: string, args: string[], env: Record<string, string>): Promise<ProcessResult> {
  const started = performance.now();
  const child = spawn(command, args, { env, cwd: sdk, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, timedOut = false, overflow = false;
  const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 180_000);
  child.stdout.on('data', (value: Buffer) => { bytes += value.length; stdout.push(value); if (bytes > 1024 * 1024) { overflow = true; stop(); } });
  child.stderr.on('data', (value: Buffer) => { bytes += value.length; stderr.push(value); if (bytes > 1024 * 1024) { overflow = true; stop(); } });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
    assert(!timedOut, 'bounded measurement subprocess deadline exceeded');
    assert(!overflow, 'bounded measurement output exceeded');
    return { ...result, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), parent_wall_ms: performance.now() - started };
  } finally { clearTimeout(timer); }
}
const version = await run(node20, ['--version'], environment);
assert.equal(version.code, 0, version.stderr);
assert.match(version.stdout.trim(), /^v20\./);
const sourceHashes: Record<string, string> = {};
for (const file of [wrapperSource, cli, join(sdk, 'packages/mcp/dist/server.js'), join(sdk, 'packages/operations/dist/diagnostics.js'), join(sdk, 'packages/operations/src/operations/apps.ts'), join(sdk, 'packages/operations/src/tc-apps/copy.ts'), ...['diagnostics-measure.ts', 'diagnostics-measure-node.mjs', 'diagnostics-measure-apps.ts', 'diagnostics-measure-common.mjs'].map(name => join(import.meta.dir, name))]) {
  sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
type Measurement = Record<string, unknown> & { business: unknown };
const observations: Record<string, unknown>[] = [];
const started = new Date().toISOString();
let active: Record<string, unknown> | null = null;
try {
  for (let sample = 0; sample < samples; sample++) {
    let baseline: { node: unknown; apps: unknown; effects: unknown } | undefined;
    // Fixed order is deliberate/reported; no hidden warm-up or shared consumer.
    for (const mode of ['off', 'on', 'failed_sink'] as const) {
      active = { sample, mode, stage: 'fixture_setup', node: null, apps: null };
      const directory = join(root, `sample-${sample}-${mode}`);
      await mkdir(directory, { mode: 0o700 });
      const home = join(directory, 'home'); await mkdir(home, { mode: 0o700 });
      const env = { ...environment, HOME: home, TC_HOME: join(home, 'profiles'), TC_DIAGNOSTICS_HOME: join(home, 'history') };
      const key = 'xyz.tinycloud.agent-data/synthetic-measurement';
      const fixture = await createHermeticEncryptedNode({ nativeBearerPath: key });
      try {
        assert.equal(new URL(fixture.host).hostname, '127.0.0.1');
        const session = fixture.ownerRestorableSession;
        await state.withTinyCloudStateRoot(env.TC_HOME, async () => {
          await state.writeJsonAtomic(state.profileConfigPath('owner'), {
            name: 'owner', host: fixture.host, chainId: session.chainId, spaceName: 'applications', spaceId: session.spaceId,
            did: fixture.ownerDid, sessionDid: session.verificationMethod.split('#')[0], posture: 'local-owner-key',
            operatorType: 'human', authMethod: 'local', privateKey: fixture.ownerPrivateKey, address: session.address, createdAt: '2026-07-15T00:00:00.000Z',
          });
          await state.writeJsonAtomic(state.sessionPath('owner'), session);
        });
        const value_text = JSON.stringify({ synthetic: true, note: 'x'.repeat(4096) });
        const seeded = await fixture.owner.kvForSpace(session.spaceId).put(key, Buffer.from(value_text));
        assert(seeded.ok, 'Could not seed hermetic node');
        const wrapper = join(home, 'wrapper'); await mkdir(wrapper, { mode: 0o700 });
        await copyFile(wrapperSource, join(wrapper, 'tc'));
        const launcher = join(wrapper, 'node20-tc');
        // Quoting a fixture-owned launcher preserves the real wrapper and pins all its helpers to Node20.
        const quotedNode = `'${node20.replaceAll("'", "'\\''")}'`;
        const quotedCli = `'${cli.replaceAll("'", "'\\''")}'`;
        await writeFile(launcher, `#!/bin/sh\nexec ${quotedNode} ${quotedCli} "$@"\n`, { mode: 0o700 });
        await writeFile(join(wrapper, 'cli-path'), launcher + '\n', { mode: 0o600 });
        const config = { mode, calls, records, cli, wrapper: join(wrapper, 'tc'), key, host: fixture.host, space: session.spaceId, value_text, result: join(directory, 'node.json') };
        const configPath = join(directory, 'config.json');
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        const before = fixture.nativeBearerStats();
        const timeFormat = '{"wall_seconds":%e,"user_seconds":%U,"system_seconds":%S,"max_rss_kib":%M,"exit_code":%x}';
        const nodeTime = join(directory, 'node-time.json');
        active.stage = 'built_node20';
        const nodeProcess = await run('/usr/bin/time', ['-f', timeFormat, '-o', nodeTime, node20, join(import.meta.dir, 'diagnostics-measure-node.mjs'), configPath], env);
        assert.equal(nodeProcess.code, 0, nodeProcess.stderr);
        const node = JSON.parse(await readFile(config.result, 'utf8')) as Measurement;
        active.node = node;
        const after = fixture.nativeBearerStats();
        const effects = Object.fromEntries(Object.keys(before).map(key => [key, after[key as keyof typeof after] - before[key as keyof typeof before]]));
        config.result = join(directory, 'apps.json');
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        const appsTime = join(directory, 'apps-time.json');
        const appsEnv = { ...env, TC_HOME: join(home, 'apps-profiles'), TC_DIAGNOSTICS_HOME: join(home, 'apps-history') };
        active.stage = 'bun_source_apps';
        const appsProcess = await run('/usr/bin/time', ['-f', timeFormat, '-o', appsTime, process.execPath, join(import.meta.dir, 'diagnostics-measure-apps.ts'), configPath], appsEnv);
        let apps: Measurement | undefined;
        try { apps = JSON.parse(await readFile(config.result, 'utf8')) as Measurement; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        active.apps = apps ?? null;
        assert.equal(appsProcess.code, 0, appsProcess.stderr);
        assert(apps, 'Source consumer exited without measurement JSON');
        active.stage = 'business_parity';
        const business = { node: node.business, apps: apps.business, effects };
        if (baseline) assert.deepEqual(business, baseline, `Business output/effect parity failed: sample ${sample}, ${mode}`);
        else baseline = business;
        const businessDigest = createHash('sha256').update(JSON.stringify(business)).digest('hex');
        delete (node as Record<string, unknown>).business; delete (apps as Record<string, unknown>).business;
        observations.push({ sample, mode, node, apps, effects, parity: { baseline_equal: true, synthetic_business_sha256: businessDigest },
          node_process: { ...JSON.parse(await readFile(nodeTime, 'utf8')), parent_wall_ms: nodeProcess.parent_wall_ms, stderr_bytes: Buffer.byteLength(nodeProcess.stderr) },
          apps_process: { ...JSON.parse(await readFile(appsTime, 'utf8')), parent_wall_ms: appsProcess.parent_wall_ms, stderr_bytes: Buffer.byteLength(appsProcess.stderr) } });
      } finally { fixture.stop(); await rm(directory, { recursive: true, force: true }); }
    }
  }
  const report = {
    schema_version: 1, completed: true, private_synthetic_only: true, started, finished: new Date().toISOString(),
    runtimes: { node20: version.stdout.trim(), orchestrator_bun: Bun.version }, source_sha256: sourceHashes,
    controls: { samples_per_mode: samples, modes: ['off', 'on', 'failed_sink'], repeated_mcp_calls_per_sample: calls, cold_mcp_calls_per_sample: 1, copy_records: records, read_records: 100, business_children: 8, client_runs: 2 },
    observations,
    method: { consumer_cache: 'fresh process/profile for every mode/sample; empty SQLite and identical KV; no unreported consumer warmup', order: 'off,on,failed_sink fixed within sample', host_page_cache: 'not flushed; later modes may benefit from OS caches', failed_sink: 'real .writer-lock held after parent consumer admission through business-child completion and this runtime close; child discovery may fail before admission; isolated child-writer quiescence is not observed and late evidence may arrive after unlock', detail: 'not selected or enabled', quantiles: 'not computed', sla: 'none asserted',
      cpu_rss: 'GNU time reports launched-process resource accounting, including reaped-child CPU where supplied by OS; maxRSS is a high-water maximum, not sum of concurrent process RSS. Bun hermetic host CPU/RSS is excluded from Node process measurements; Bun copy backend is in its consumer and included.',
      cold: 'script module imports and first MCP call separate; GNU time includes whole process startup, setup, work, drain, review and exit. No subtraction yields an isolated process startup metric.',
      review: 'one local review machine time; usage is a subsequent inspection, not an atomic observation with review; no human approval or interpretation measured',
      losses: 'missing evidence is null/coverage gaps, not inferred zero; sampled queue bytes are not a high-water observation; per-lock waits and child drain durations are not exposed',
      comparison: 'raw paired observations only; no latency threshold or capacity claim; synthetic business hashes are not production diagnostic metadata' },
    limitations: ['Registered MCP local stateless transport is not hosted OAuth/client-installed acceptance.', 'Node20 built consumer and Bun source apps/copy are separate datasets; do not combine as Node20 copy proof.', 'One copy rebuild per fresh sample; repeated MCP calls within a sample share warm process state.', 'Four wrappers execute successful reads: existing 2/4-second retry sleeps are reported but not exercised.', 'Diagnostics lock contention is exercised; native hangs, disk full and worker death are separate acceptance fixtures.', 'No synthetic detail tier is enabled; detail bytes measured without claiming selected-detail overhead.'],
  };
  const output = join(root, 'results.json');
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  process.stdout.write(output + '\n');
} catch (error) {
  const output = join(root, 'results-incomplete.json');
  await writeFile(output, JSON.stringify({
    schema_version: 1, completed: false, private_synthetic_only: true, started,
    runtimes: { node20: version.stdout.trim(), orchestrator_bun: Bun.version }, source_sha256: sourceHashes,
    controls: { samples, calls, records }, observations, active_observation: active,
    failure: error instanceof Error ? error.message : 'Unknown fixture failure',
    limitations: ['Unfinished work has no invented timings, parity, coverage or counters. Completed observations remain available; this is not a passing measurement.'],
  }, null, 2), { mode: 0o600 });
  process.stdout.write(output + '\n');
  process.exitCode = 1;
} finally { await rm(join(root, 'bootstrap'), { recursive: true, force: true }); }
