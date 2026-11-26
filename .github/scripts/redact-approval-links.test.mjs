import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { redactApprovalLinks } from "./redact-approval-links.mjs";

const script = fileURLToPath(new URL("./redact-approval-links.mjs", import.meta.url));
const ID = "vrvmxdvgzwgkxmsrzcfpfqbljc";
const KEY = "LaEsCG8UdojERGSJsaM16arolfEaf1PIjNRlK-UDtjY";
const CID = "bafkreice67qbvd2aiktiubg7mtm7zzj7fq45vsuux453uo7mvmbc7bsxrq";
const LINK = `https://openkey.example/a/${ID}#v=4&k=${KEY}&c=${CID}`;

const leaks = (text) => [ID, KEY, "#v=4"].filter((secret) => text.includes(secret));

test("a Bun diff line, a JSON dump and a bare id keep no link, fragment, key or id", () => {
  for (const line of [
    `-   "${LINK}",`,
    `error: {"requestId":"${ID}","approvalUrl":"${LINK}","bodyCid":"${CID}"}`,
    `Approve in OpenKey (open the complete link):\r`,
    `${LINK}`,
    `\u001b[31m"${LINK}"\u001b[0m`,
    `Received: "${ID}"`,
    `fragment #v=4&k=${KEY}&c=${CID}`,
    `key k=${KEY}`,
    `https://openkey.example/a/${ID}`,
  ]) assert.deepEqual(leaks(redactApprovalLinks(line)), [], line);
});

test("equal values get equal tokens and different values different ones", () => {
  assert.equal(redactApprovalLinks(LINK), redactApprovalLinks(LINK));
  assert.notEqual(redactApprovalLinks(LINK), redactApprovalLinks(LINK.replace(ID, "a".repeat(26))));
  assert.notEqual(redactApprovalLinks(ID), redactApprovalLinks("a".repeat(26)));
});

test("other output is unchanged", () => {
  for (const line of [
    " 8 pass",
    "(fail) a resumed request past its own expiry > OpenKey says it expired",
    "https://node.example/v1/health",
    `"bodyCid": "${CID}",`,
    "APPROVAL_REQUEST_EXPIRED: did:key:z6MkoBhTfoA25om2WnwBtS9L8ywetSV6JmUdKfmuKC4zF4hC",
    "abcdefghijklmnopqrstuvwxyz0",
  ]) assert.equal(redactApprovalLinks(line), line);
});

test("as a filter it copies every line, the last one without a newline too", () => {
  const result = spawnSync(process.execPath, [script], { input: `one\n${LINK}\n 3 fail`, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.deepEqual([lines[0], lines[2], lines.length], ["one", " 3 fail", 4]);
  assert.match(lines[1], /^\[approval-link [0-9a-f]{12}\]$/);
});
