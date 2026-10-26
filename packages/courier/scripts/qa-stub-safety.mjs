// Preloaded in the stub and every CLI child. No SDK imports before this fence.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export function scrubEnvironment(state) {
  const env = {
    HOME: path.join(state, 'home'), COURIER_HOME: path.join(state, 'courier'),
    PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: state,
    BUN_INSTALL_CACHE_DIR: path.join(state, 'bun-cache'),
    COURIER_TEST: '1', COURIER_TEST_HOME: state,
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

export function installSafety(host, state, cli, guard = new URL('./qa-stub-safety.mjs', import.meta.url).pathname) {
  const target = new URL(host);
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  // Local node only: prevents an explicit typo from reaching a production identity.
  if (!allowed.has(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('--host must be a loopback http(s) node URL');
  }
  const audit = (event) => fs.appendFileSync(path.join(state, 'safety.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  const checkUrl = (value) => {
    const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url);
    if (url.origin !== target.origin) throw new Error('QA network fence refused non-node origin');
    audit({ type: 'network', origin: url.origin });
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { checkUrl(input); return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), redirect: 'error' }); };
  for (const module of [http, https]) {
    const request = module.request;
    module.request = function (...args) {
      const arg = args[0];
      if (typeof arg === 'string' || arg instanceof URL) checkUrl(arg);
      else checkUrl(`${arg.protocol ?? (module === https ? 'https:' : 'http:')}//${arg.hostname ?? arg.host}:${arg.port ?? (module === https ? 443 : 80)}`);
      return request.apply(this, args);
    };
    module.get = function (...args) { const req = module.request(...args); req.end(); return req; };
  }
  // Guard socket destinations too, including SDKs using their own HTTP client.
  const checkSocket = (args, secure = false) => {
    if (Array.isArray(args[0])) args = args[0];
    const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const hostname = opts.hostname ?? opts.host ?? 'localhost';
    if (opts.path || !allowed.has(hostname) || Number(opts.port ?? (secure ? 443 : 80)) !== Number(target.port || (target.protocol === 'https:' ? 443 : 80))) {
      throw new Error('QA socket fence refused non-node destination');
    }
    audit({ type: 'socket', host: hostname, port: Number(opts.port) });
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { checkSocket(args); return connect.apply(this, args); };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) { checkSocket(args, true); return tlsConnect.apply(this, args); };
  const execFile = cp.execFile;
  cp.execFile = function (file, args, options, callback) {
    const prefix = ['--import', guard, cli];
    if (file !== process.execPath || !Array.isArray(args) || !prefix.every((v, i) => args[i] === v) || !['init', 'pair', 'inbox', 'read', 'send', 'pause', 'resume', 'revoke'].includes(args[3])) throw new Error('QA process fence refused child');
    audit({ type: 'child', file, argv: args, envKeys: Object.keys(options.env).sort() });
    return execFile.call(this, file, args, options, callback);
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
    cp[name] = () => { throw new Error('QA process fence refused child'); };
  }
  syncBuiltinESMExports();
  process.env.COURIER_FAKE_OPENKEY_HOST = host;
  process.env.QA_STUB_HOST = host;
  process.env.QA_STUB_STATE = state;
  process.env.QA_STUB_CLI = cli;
  audit({ type: 'fence', host: target.origin, envKeys: Object.keys(process.env).sort(), wake: 'none', notify: 'none' });
}

if (process.env.QA_STUB_HOST) {
  const { QA_STUB_HOST: host, QA_STUB_STATE: state, QA_STUB_CLI: cli } = process.env;
  scrubEnvironment(state);
  installSafety(host, state, cli);
}
