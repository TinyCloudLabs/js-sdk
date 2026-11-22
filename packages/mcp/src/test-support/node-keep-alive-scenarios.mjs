// Runs the keep-alive scenarios under Node.js against the built module, because the
// hosted MCP runs on Node.js's fetch and Bun substitutes its own for `undici`.
// Prints one JSON object. Servers behave like the node ingress: an idle
// connection is closed after `idleCloseMs` and no Keep-Alive header is sent.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { fetch } from "undici";

import {
  createNodeKeepAliveAgent,
  NODE_KEEP_ALIVE_TIMEOUT_MS,
  installNodeKeepAlive,
  retryReadOnConnectionReset,
} from "../../dist/node-keep-alive.js";

async function startServer(idleCloseMs, answer) {
  const counts = { connections: 0, requests: 0 };
  const server = createServer((request, response) => {
    counts.requests += 1;
    answer(request, response, counts.requests);
  });
  server.keepAliveTimeout = 0;
  server.on("connection", (socket) => {
    counts.connections += 1;
    socket.setTimeout(idleCloseMs, () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, counts, server };
}

// A failed request is reported the way the SDK services report it: an error value that keeps its cause.
async function read(url, dispatcher) {
  try {
    const response = await fetch(url, { method: "POST", body: "{}", dispatcher });
    await response.arrayBuffer();
    return response.ok ? { ok: true } : { ok: false, error: { code: "NETWORK_ERROR", status: response.status } };
  } catch (error) {
    return { ok: false, error: { code: "NETWORK_ERROR", cause: error } };
  }
}

async function withServer(idleCloseMs, keepAliveMs, answer, run) {
  const probe = await startServer(idleCloseMs, answer);
  const agent = createNodeKeepAliveAgent(keepAliveMs);
  try {
    return await run(probe, agent);
  } finally {
    await agent.close();
    probe.server.closeAllConnections();
    await new Promise((resolve) => probe.server.close(resolve));
  }
}

const respond = (_request, response) => void response.end("ok");
const results = { limit: NODE_KEEP_ALIVE_TIMEOUT_MS };

// The 61 s / 62 s / 65 s ordering of the node ingress, scaled to 1.5 s / 2 s / 2.5 s.
results.reuse = await withServer(2_500, 2_000, respond, async (probe, agent) => {
  const answers = [];
  for (let call = 0; call < 5; call += 1) {
    answers.push((await read(probe.url, agent)).ok);
    if (call < 4) await sleep(1_500);
  }
  return { ...probe.counts, answers };
});

results.expired = await withServer(2_500, 1_000, respond, async (probe, agent) => {
  const first = await read(probe.url, agent);
  await sleep(1_400);
  const second = await read(probe.url, agent);
  return { ...probe.counts, answers: [first.ok, second.ok] };
});

results.resetOnce = await withServer(
  60_000,
  2_000,
  (request, response, requests) => (requests === 1 ? request.socket.destroy() : response.end("ok")),
  async (probe, agent) => ({ ok: (await retryReadOnConnectionReset(() => read(probe.url, agent))).ok, ...probe.counts }),
);

results.resetTwice = await withServer(60_000, 2_000, (request) => request.socket.destroy(), async (probe, agent) => ({
  ok: (await retryReadOnConnectionReset(() => read(probe.url, agent))).ok,
  ...probe.counts,
}));

results.errorStatus = await withServer(
  60_000,
  2_000,
  (_request, response) => {
    response.statusCode = 500;
    response.end("failed");
  },
  async (probe, agent) => ({ result: await retryReadOnConnectionReset(() => read(probe.url, agent)), ...probe.counts }),
);

// Node.js's own `fetch`, with only the installed dispatcher, keeps a connection idle for longer than the 4 s default.
results.installed = await (async () => {
  const probe = await startServer(10_000, respond);
  installNodeKeepAlive();
  try {
    const answers = [];
    for (let call = 0; call < 2; call += 1) {
      const response = await globalThis.fetch(probe.url, { method: "POST", body: "{}" });
      await response.arrayBuffer();
      answers.push(response.ok);
      if (call === 0) await sleep(4_600);
    }
    return { ...probe.counts, answers };
  } finally {
    probe.server.closeAllConnections();
    await new Promise((resolve) => probe.server.close(resolve));
  }
})();

const reset = Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
});
let resetAttempts = 0;
// The thrown-error cases need no server.
const resetRejection = await retryReadOnConnectionReset(async () => {
  resetAttempts += 1;
  throw reset;
}).catch((error) => error);
const other = new Error("invalid input");
let otherAttempts = 0;
const otherRejection = await retryReadOnConnectionReset(async () => {
  otherAttempts += 1;
  throw other;
}).catch((error) => error);
results.thrown = {
  resetAttempts,
  resetPropagated: resetRejection === reset,
  otherAttempts,
  otherPropagated: otherRejection === other,
};

process.stdout.write(`${JSON.stringify(results)}\n`);
