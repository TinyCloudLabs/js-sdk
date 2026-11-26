#!/usr/bin/env node
// Copies stdin to stdout with OpenKey approval links, link fragments and
// request ids replaced by a short digest (TC-4415). The CLI approval tests
// compare fixture links and request ids, and a failing assertion makes Bun
// print both sides into the Actions log, as do failure messages that carry a
// child's captured stdout/stderr. Piping the test output through this filter
// keeps every such value out of the log, whichever path printed it.
//
//   bun test <file> 2>&1 | node .github/scripts/redact-approval-links.mjs
//
// The same value always becomes the same token, so a diff still shows which
// links or ids are equal and which differ.
//
// Each line is first normalized, and the normalized line is what is printed:
// terminal escape sequences (colour) are removed, and the JSON escapes `\/`,
// `\u0023`, `\u0026`, `\u003d` and the percent escapes %23 %26 %3D %2F %3A
// are decoded, so an escaped or URL-encoded link is matched like a plain one.
//
// What is then replaced:
// - a URL that has a fragment, or whose path is `/<letter>/<id>` (the short
//   link form `<origin>/a/<id>#v=4&k=..&c=..`): the whole URL;
// - a link fragment printed on its own (`#v=4&...`);
// - a link key or full-link payload printed on its own, bare or labelled
//   (`k=...`, `r=...`, `k: "..."`, `"key":"..."`);
// - a request id printed on its own: 26 characters of lowercase base32.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const URL_CHAR = "[^\\s\"'`<>\\\\\\x00-\\x1f\\x7f]";
const ID = "[a-z2-7]{26}";
const URL_PATTERN = new RegExp(`https?://${URL_CHAR}+`, "g");
const SHORT_LINK_PATH = new RegExp(`/[a-z]/${ID}(?![a-z2-7])`);
const FRAGMENT_PATTERN = new RegExp(`#v=[0-9]+&${URL_CHAR}*`, "g");
// `key:` must be followed by a quote or a space, so `did:key:z6Mk…` is left alone.
const KEY_PATTERN = /(?<![A-Za-z0-9_-])(["']?(?:k|r|key)["']?(?:\s*=\s*["']?|\s*:\s*["']|\s*:\s+))([A-Za-z0-9_-]{16,})/g;
const ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESCAPED = { "\\/": "/", "\\u0023": "#", "\\u0026": "&", "\\u003d": "=" };
const ID_PATTERN = new RegExp(`(?<![A-Za-z0-9_-])${ID}(?![A-Za-z0-9_-])`, "g");

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** Undoes colour, JSON and percent escaping that would hide a link from the patterns below. */
function normalize(line) {
  return line
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\\\/|\\u0023|\\u0026|\\u003d/gi, (escape) => ESCAPED[escape.toLowerCase()])
    .replace(/%(23|26|3d|2f|3a)/gi, (_escape, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Returns `line`, normalized, with every approval link, fragment, link key and request id replaced. */
export function redactApprovalLinks(line) {
  return normalize(line)
    .replace(URL_PATTERN, (url) => (url.includes("#") || SHORT_LINK_PATH.test(url) ? `[approval-link ${digest(url)}]` : url))
    .replace(FRAGMENT_PATTERN, (fragment) => `#[link-fragment ${digest(fragment)}]`)
    .replace(KEY_PATTERN, (_match, label, value) => `${label}[link-key ${digest(value)}]`)
    .replace(ID_PATTERN, (id) => `[request-id ${digest(id)}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) process.stdout.write(`${redactApprovalLinks(line)}\n`);
}
