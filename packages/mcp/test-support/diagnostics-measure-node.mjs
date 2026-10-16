// Run only through diagnostics-measure.ts, with an explicit real Node 20 binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const entryStarted = performance.now();
const process_start_to_entry_ms = process.uptime() * 1000;
const [{ createMcpHandler }, { createTinyCloudMcpServer }, diagnostics, { capture, measure }] = await Promise.all([
  import('@modelcontextprotocol/server'), import('../dist/server.js'),
  import('@tinycloud/operations/diagnostics'), import('./diagnostics-measure-common.mjs'),
]);
const module_import_ms = performance.now() - entryStarted;
assert.equal(process.versions.node.split('.')[0], '20', 'Node20 measurement requires actual Node20');
assert(process.env.HOME.includes('tc-diagnostics-measure-'));
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const history = await capture(config.mode, process.env.TC_DIAGNOSTICS_HOME, 'mcp_http');
const handler = createMcpHandler(() => createTinyCloudMcpServer({
  profile: 'owner', explicitProfile: true, allowOwnerProfile: true, stateRoot: process.env.TC_HOME,
}), { legacy: 'stateless', onerror: () => {} });
const run_ids = [randomUUID(), randomUUID()];
let request = 0;
async function call() {
  const response = await diagnostics.withDiagnosticContext(history.binding
    ? diagnostics.makeDiagnosticContext(history.binding, 'mcp_http', { run_id: run_ids[0] }) : undefined,
  () => handler.fetch(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++request, method: 'tools/call', params: {
      name: 'tinycloud_kv_get', arguments: { key: config.key, space: config.space, representation: 'json' },
    } }),
  })));
  const text = await response.text();
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(text)];
  const result = messages.find(message => message.id === request)?.result;
  assert.equal(response.status, 200);
  assert.equal(result?.structuredContent?.status, 'ok', text);
  return result.structuredContent.output;
}
async function child(index) {
  const args = ['kv', 'get', config.key, '--raw', '--quiet', '--profile', 'owner', '--host', config.host, '--space', config.space];
  const wrapped = index % 2 === 1;
  const start = performance.now();
  const processChild = spawn(wrapped ? '/bin/sh' : process.execPath, wrapped ? [config.wrapper, ...args] : [config.cli, ...args], {
    env: { ...process.env, TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: 'tc-apps', run_id: run_ids[index < 4 ? 0 : 1], workflow_id: randomUUID() }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  processChild.stdout.on('data', value => stdout.push(value));
  processChild.stderr.on('data', value => stderr.push(value));
  const code = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve); });
  const output = Buffer.concat(stdout).toString();
  const error = Buffer.concat(stderr).toString();
  assert.equal(code, 0, error);
  assert.equal(output, config.value_text);
  assert.equal(error, '');
  return { index, wrapped, run_index: index < 4 ? 0 : 1, wall_ms: performance.now() - start, code, stdout: output, stderr: error };
}
try {
  const cold_call = await measure(call);
  const repeated_calls = [];
  for (let index = 0; index < config.calls; index++) repeated_calls.push(await measure(call));
  const fanout = await measure(() => Promise.all(Array.from({ length: 8 }, (_, index) => child(index))));
  await handler.close();
  const diagnostic = await history.finish();
  const results = {
    runtime: { kind: 'built_consumer', node: process.versions.node, execPath: process.execPath },
    module_import_ms, process_start_to_entry_ms, cold_call, repeated_calls, fanout, diagnostic, client_runs: 2,
    business: { outputs: [cold_call.value, ...repeated_calls.map(value => value.value)], children: fanout.value.map(({ code, stdout, stderr }) => ({ code, stdout, stderr })) },
    existing_wrapper_sleep: { exercised: false, scheduled_ms: 0, reason: 'healthy business requests; failed diagnostic sink is not a business network retry', production_retry_schedule_ms: [2000, 4000], actual_sleep_ms: null },
    limitations: ['MCP uses registered stateless handler.fetch, not hosted OAuth or a physical MCP socket; SDK dispatch is real loopback HTTP.', 'Cold call includes first handler/preparation/node dispatch; module import is separate. process_start_to_entry_ms uses process.uptime and is not parent spawn-to-entry wall time.', 'Eight business children are four direct CLI and four wrappers; diagnostic helper subprocesses are additional.', 'Child runtime acceptance/loss counters and individual child CPU/RSS are unavailable, not zero.', 'Normal service stderr logs are not treated as diagnostic metadata or parity output.'],
  };
  await writeFile(config.result, JSON.stringify(results), { mode: 0o600 });
} finally {
  await handler.close();
  await history.runtime.close();
}
