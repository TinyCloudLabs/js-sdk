import '../../../operations/test-support/test-bootstrap.mjs';
import { assertPrivateTestEnvironment } from '../../../operations/test-support/private-home.mjs';
import { appendFileSync } from 'node:fs';
import { Server } from 'node:http';
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, REGISTRY_NOT_FOUND_BODY } from '@tinycloud/sdk-core';

const defaultOrigin = new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin;
let origins = new Set();
let originalFetch;
let originalListen;
let fixtureFetch;
let fixtureListen;

function registerOrigin(value) {
  const url = new URL(value);
  const port = Number(url.port || 80);
  if (url.protocol !== 'http:' || url.username || url.password ||
      (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') ||
      !Number.isSafeInteger(port) || port <= 0 || port > 65535 || (port >= 48100 && port <= 48106)) {
    throw new Error('MCP fixture requires an owned HTTP loopback origin');
  }
  origins.add(url.origin);
  return url.origin;
}

export function registerMcpFixtureServer(server) {
  if (!(server instanceof Server) || !server.listening) throw new Error('MCP fixture requires a listening HTTP server');
  const address = server.address();
  if (address === null || typeof address === 'string') return;
  const host = address.address === '::1' ? '[::1]' : address.address;
  const origin = registerOrigin(`http://${host}:${address.port}`);
  const registeredOrigins = origins;
  server.once('close', () => registeredOrigins.delete(origin));
}

export function installMcpRegistryFixture(origin) {
  assertPrivateTestEnvironment();
  if (origin !== undefined) registerOrigin(origin);
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  originalListen = Server.prototype.listen;
  const listen = originalListen;
  const ownListen = function (...args) {
    if (fixtureListen === ownListen) {
      this.once('listening', () => {
        if (fixtureListen === ownListen) registerMcpFixtureServer(this);
      });
    }
    return Reflect.apply(listen, this, args);
  };
  fixtureListen = ownListen;
  Server.prototype.listen = ownListen;
  const send = originalFetch;
  const guarded = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const metadata = method === 'GET' && /^\/v[12]\/locations\/[^/]+$/.test(url.pathname);
    if (metadata) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.has('authorization')) throw new Error('Registry metadata must not receive authority headers');
    }
    if (url.origin === defaultOrigin && metadata) {
      if (process.env.TC_TEST_MOCK_REGISTRY_LOG) {
        appendFileSync(process.env.TC_TEST_MOCK_REGISTRY_LOG, `${JSON.stringify({
          kind: 'mocked_registry_lookup', pid: process.pid, method, origin: url.origin,
          path: url.pathname, authorizationPresent: false,
        })}\n`, { mode: 0o600 });
      }
      return Promise.resolve(new Response(REGISTRY_NOT_FOUND_BODY, {
        status: 404, headers: { 'content-type': 'application/json' },
      }));
    }
    if (!origins.has(url.origin)) throw new Error(`Non-fixture origin refused: ${url.origin}`);
    return send(input, init);
  };
  if (typeof send.preconnect === 'function') {
    guarded.preconnect = (value, ...args) => {
      const url = new URL(value);
      if (!origins.has(url.origin)) throw new Error(`Non-fixture origin refused: ${url.origin}`);
      return send.preconnect(value, ...args);
    };
  }
  fixtureFetch = guarded;
  globalThis.fetch = guarded;
}

export function resetMcpRegistryFixture() {
  if (globalThis.fetch === fixtureFetch) globalThis.fetch = originalFetch;
  if (Server.prototype.listen === fixtureListen) Server.prototype.listen = originalListen;
  originalFetch = undefined;
  originalListen = undefined;
  fixtureFetch = undefined;
  fixtureListen = undefined;
  origins = new Set();
}

if (process.env.TC_TEST_MCP_NODE_ORIGIN) {
  installMcpRegistryFixture(process.env.TC_TEST_MCP_NODE_ORIGIN);
}
