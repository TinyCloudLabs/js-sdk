// TC-3211: the SDK retries a node's busy/timeout answers (4 attempts, honouring Retry-After). Courier's own read retry must
// not retry them again, or one read costs a busy node 3 x 4 requests. The node here is a fake that counts requests on the
// wire; the SDK's service context, KV service and retry are the real ones (read from source: this package's tests do not
// need the SDK built).
import { expect, test } from 'bun:test';
import { ServiceContext } from '../../sdk-services/src/context';
import { KVService } from '../../sdk-services/src/kv/KVService';
import { getJson, getJsonMany, listAll } from '../src/store';

const SDK_ATTEMPTS = 4;

/** A KV service over a node that answers every request with `answer()`, and the number of requests it got. */
function kvOverNode(answer: () => Response) {
  const wire = { requests: 0 };
  const context = new ServiceContext({
    hosts: ['https://node.test'],
    invoke: () => ({ Authorization: 'signed' }),
    invokeAny: () => ({ Authorization: 'signed' }),
    fetch: async () => {
      wire.requests += 1;
      return answer();
    },
    // No waiting between SDK attempts; the policy is otherwise the default (4 attempts).
    retryPolicy: { baseDelayMs: 1, maxDelayMs: 1 },
  });
  context.setSession({
    delegationHeader: { Authorization: 'test' },
    delegationCid: 'bafytest',
    spaceId: 'tinycloud:pkh:eip155:1:0xabc:default',
    verificationMethod: 'did:key:test',
    jwk: {},
  });
  const kv = new KVService({});
  kv.initialize(context);
  return { kv: kv as never, wire };
}

const busy = () => new Response('sql_busy: begin: database is busy', { status: 503, headers: { 'retry-after': '0' } });
const timeout = () => new Response('request_timeout: deadline passed', { status: 503, headers: { 'retry-after': '0' } });

const reads = {
  get: (kv: Parameters<typeof getJson>[0]) => getJson(kv, 'a'),
  list: (kv: Parameters<typeof getJson>[0]) => listAll(kv, 'p/'),
  'batch get': (kv: Parameters<typeof getJson>[0]) => getJsonMany(kv, ['a', 'b']),
};

for (const [name, answer] of [['busy', busy], ['timeout', timeout]] as const) {
  for (const [read, run] of Object.entries(reads)) {
    test(`a ${read} that finds the node ${name} costs it the SDK's attempts only`, async () => {
      const { kv, wire } = kvOverNode(answer);
      await expect(run(kv)).rejects.toMatchObject({ code: name === 'busy' ? 'NODE_BUSY' : 'REQUEST_TIMEOUT' });
      expect(wire.requests).toBe(SDK_ATTEMPTS);
    });
  }
}

test('another 5xx is still retried by Courier, three tries', async () => {
  const { kv, wire } = kvOverNode(() => new Response('boom', { status: 500 }));
  await expect(getJson(kv, 'a')).rejects.toBeDefined();
  // The SDK does not retry a bare 500, so each of Courier's three tries is one request.
  expect(wire.requests).toBe(3);
}, 15_000);
