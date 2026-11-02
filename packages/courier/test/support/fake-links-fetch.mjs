// Preloaded into a SPAWNED Courier/CLI process (NODE_OPTIONS=--import <this file>) by tests that run `init --request`:
// answers the links API's create call locally, so a test can never POST to a real service. Everything else passes
// through. Pair it with TC_LINKS_API_ORIGIN=https://links.fixture.invalid: if this module is not loaded the request
// fails to resolve instead of reaching production. Not a test file.
import { randomBytes } from 'node:crypto';

const origin = process.env.TC_LINKS_API_ORIGIN;
const real = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (origin && url === `${origin}/v1/links` && init?.method === 'POST') {
    const record = JSON.parse(init.body);
    const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join('');
    return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
  }
  return real(input, init);
};
