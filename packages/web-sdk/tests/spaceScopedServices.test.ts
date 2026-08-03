const { TextEncoder: TE, TextDecoder: TD } = require('util');

global.TextEncoder = TE;
global.TextDecoder = TD;

const { TinyCloudWeb } = require('../src');

// sqlForSpace/kvForSpace are thin passthroughs to the underlying TinyCloudNode,
// mirroring `get sql()`/`get kv()`. We inject a fake node so the test doesn't
// require WASM/sign-in, and assert the spaceId forwards and the node's
// space-scoped service is returned unchanged.
function withFakeNode() {
  const tcw = new TinyCloudWeb();
  const calls = { sql: [], kv: [] };
  const sqlService = { tag: 'sql-for-space' };
  const kvService = { tag: 'kv-for-space' };
  const fakeNode = {
    sqlForSpace: (spaceId) => {
      calls.sql.push(spaceId);
      return sqlService;
    },
    kvForSpace: (spaceId) => {
      calls.kv.push(spaceId);
      return kvService;
    },
  };
  tcw._node = fakeNode;
  return { tcw, calls, sqlService, kvService };
}

const SPACE = 'tinycloud:pkh:eip155:1:0xowner:applications';

test('sqlForSpace forwards the space URI to node.sqlForSpace and returns its service', () => {
  const { tcw, calls, sqlService } = withFakeNode();
  expect(tcw.sqlForSpace(SPACE)).toBe(sqlService);
  expect(calls.sql).toEqual([SPACE]);
});

test('kvForSpace forwards the space URI to node.kvForSpace and returns its service', () => {
  const { tcw, calls, kvService } = withFakeNode();
  expect(tcw.kvForSpace(SPACE)).toBe(kvService);
  expect(calls.kv).toEqual([SPACE]);
});

test('space-scoped accessors throw before initialization (no _node)', () => {
  const tcw = new TinyCloudWeb();
  expect(() => tcw.sqlForSpace(SPACE)).toThrow(/not yet initialized/);
  expect(() => tcw.kvForSpace(SPACE)).toThrow(/not yet initialized/);
});
