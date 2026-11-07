// Test-only default-registry transport. The SDK still classifies the canonical
// cold no-entry response; no registry policy or signature check is disabled.
import '../../../operations/test-support/test-bootstrap.mjs';
import { assertPrivateTestEnvironment } from '../../../operations/test-support/private-home.mjs';
import { appendFileSync } from 'node:fs';
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, REGISTRY_NOT_FOUND_BODY } from '@tinycloud/sdk-core';

const defaultOrigin = new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin;

export function installCourierRegistryFixture(origin) {
  assertPrivateTestEnvironment();
  const owned = new URL(origin);
  if ((owned.protocol !== 'http:' && owned.protocol !== 'https:') ||
      (owned.hostname !== '127.0.0.1' && owned.hostname !== 'localhost' && owned.hostname !== '[::1]') ||
      /^4810[0-6]$/.test(owned.port)) {
    throw new Error('Courier fixture requires an owned loopback origin');
  }
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === defaultOrigin && method === 'GET' && /^\/v[12]\/locations\/[^/]+$/.test(url.pathname)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.has('authorization')) throw new Error('Registry metadata must not receive authority headers');
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
    if (url.origin !== owned.origin) throw new Error(`Non-fixture origin refused: ${url.origin}`);
    return real(input, init);
  }, { preconnect: real.preconnect });
}

/** Shared by the real CLI subprocess fixtures; guard executes before SDK imports. */
export function courierRegistryFixtureEnv(home, origin) {
  const env = {
    ...process.env, HOME: home, TC_HOME: home, USERPROFILE: home, COURIER_HOME: home,
    COURIER_TEST_NODE_ORIGIN: origin,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${import.meta.url}`.trim(),
  };
  assertPrivateTestEnvironment(env, home);
  return env;
}

if (process.env.COURIER_TEST_NODE_ORIGIN) installCourierRegistryFixture(process.env.COURIER_TEST_NODE_ORIGIN);
