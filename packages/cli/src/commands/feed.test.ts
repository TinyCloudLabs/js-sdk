import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeedRunner } from "../feed/runner";
import { openFeedHandoff } from "../feed/local";
import { deliverFeedResponse, getFeedHandoff, initializeFeedHandoff } from "../../../sdk-services/src/feed";
import type { FeedResponse } from "../../../sdk-services/src/feed";

const directories: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const response: FeedResponse = {
  responseId: "response-real-runner", sequence: 1, cardId: "card-real-runner", revision: 1,
  issuanceId: "issuance-real-runner", kind: "answer", text: "$(touch should-not-exist); literal input",
  createdAt: "2026-10-28T12:00:00Z",
};

test("runner receives exact JSON on stdin without shell interpolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tc2205-runner-"));
  directories.push(directory);
  const output = join(directory, "draft.json");
  const code = `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],input));`;
  expect(await runFeedRunner([process.execPath, "-e", code, output], response)).toBe("delivered");
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(response);
});

test("runtime failure after a real action stays unconfirmed across durable local reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tc2205-runner-"));
  directories.push(directory);
  const output = join(directory, "draft.txt");
  const path = join(directory, "handoff.sqlite");
  const code = `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.appendFileSync(process.argv[1],JSON.parse(input).responseId+'\\n');process.exit(1)});`;
  const argv: [string, ...string[]] = [process.execPath, "-e", code, output];
  const first = await openFeedHandoff(path);
  try {
    expect((await initializeFeedHandoff(first.handle)).ok).toBe(true);
    const result = await deliverFeedResponse({
      handoff: first.handle, recipient: "actual-runner", response,
      deliver: (item) => runFeedRunner(argv, item),
    });
    expect(result).toMatchObject({ ok: true, data: { state: "unconfirmed" } });
  } finally { first.close(); }
  const reopened = await openFeedHandoff(path);
  try {
    await deliverFeedResponse({
      handoff: reopened.handle, recipient: "actual-runner", response,
      deliver: (item) => runFeedRunner(argv, item),
    });
    expect(await getFeedHandoff(reopened.handle, response.responseId, "actual-runner"))
      .toMatchObject({ ok: true, data: { state: "unconfirmed", response } });
    expect(readFileSync(output, "utf8")).toBe(`${response.responseId}\n`);
  } finally { reopened.close(); }
});

test("interrupting a stuck runtime keeps its attempted response unconfirmed and never replays the action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tc2205-runner-abort-"));
  directories.push(directory);
  const output = join(directory, "action.txt");
  const ready = join(directory, "ready.json");
  const path = join(directory, "handoff.sqlite");
  let stopped = false;
  cleanup.push(() => {
    if (stopped || !existsSync(ready)) return;
    const { pid } = JSON.parse(readFileSync(ready, "utf8"));
    try { process.kill(pid, "SIGKILL"); } catch { /* The runner normally already exited. */ }
  });
  const started = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, file) => { if (file === "ready.json") started.resolve(); });
  watcher.on("error", started.reject);
  cleanup.push(() => watcher.close());
  // A real listening server keeps the subprocess alive without test sleeps or timers.
  const code = `const fs=require('node:fs'),net=require('node:net');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.appendFileSync(process.argv[1],JSON.parse(input).responseId+'\\n');const server=net.createServer();server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid})));});`;
  const argv: [string, ...string[]] = [process.execPath, "-e", code, output, ready];
  const abort = new AbortController();
  const first = await openFeedHandoff(path);
  try {
    expect((await initializeFeedHandoff(first.handle)).ok).toBe(true);
    const pending = deliverFeedResponse({
      handoff: first.handle, recipient: "stuck-runtime", response,
      deliver: (item) => runFeedRunner(argv, item, abort.signal),
    });
    await started.promise;
    expect(await getFeedHandoff(first.handle, response.responseId, "stuck-runtime"))
      .toMatchObject({ ok: true, data: { state: "unconfirmed" } });
    abort.abort();
    const result = await pending;
    stopped = true;
    expect(result).toMatchObject({ ok: true, data: { state: "unconfirmed" } });
    const { pid } = JSON.parse(readFileSync(ready, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { watcher.close(); first.close(); }
  const reopened = await openFeedHandoff(path);
  try {
    const replay = await deliverFeedResponse({
      handoff: reopened.handle, recipient: "stuck-runtime", response,
      deliver: (item) => runFeedRunner(argv, item),
    });
    expect(replay).toMatchObject({ ok: true, data: { state: "unconfirmed" } });
    expect(readFileSync(output, "utf8")).toBe(`${response.responseId}\n`);
  } finally { reopened.close(); }
});
