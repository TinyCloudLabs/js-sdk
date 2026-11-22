import { expect, test } from "bun:test";
import { isKnownTinyCloudNode } from "./location";

const node = "https://node.tinycloud.xyz";
const tee = "https://tee.node.tinycloud.xyz";

test("the production nodes are known without any configuration", () => {
  expect(isKnownTinyCloudNode(node)).toBe(true);
  expect(isKnownTinyCloudNode(tee)).toBe(true);
  expect(isKnownTinyCloudNode(node + "/")).toBe(true);
});

test("an origin the recipient configured is known, and only that origin", () => {
  const trusted = ["https://self-hosted.example", null, undefined];
  expect(isKnownTinyCloudNode("https://self-hosted.example", trusted)).toBe(true);
  expect(isKnownTinyCloudNode("https://other.example", trusted)).toBe(false);
  expect(isKnownTinyCloudNode("https://self-hosted.example:8443", trusted)).toBe(false);
  expect(isKnownTinyCloudNode("https://self-hosted.example")).toBe(false);
});

test("lookalike, credential, path, query and fragment forms of a known origin are refused", () => {
  const refused = [
    "https://node.tinycloud.xyz.evil.example",
    "https://tee.node.tinycloud.xyz@evil.example",
    "https://node.tinycloud.xyz@evil.example",
    "https://user:pass@node.tinycloud.xyz",
    "https://evil.example@node.tinycloud.xyz",
    "https://node.tinycloud.xyz:444",
    "https://node.tinycloud.xyz/path",
    "https://node.tinycloud.xyz/?q=1",
    "https://node.tinycloud.xyz/#x",
    "https://nodetinycloud.xyz",
    "https://tee-node.tinycloud.xyz",
    "node.tinycloud.xyz",
    "",
    "not a url",
  ];
  for (const candidate of refused) expect(isKnownTinyCloudNode(candidate, [node, tee])).toBe(false);
});

test("a path-bearing or credentialed configured origin never makes a host known", () => {
  expect(isKnownTinyCloudNode("https://self-hosted.example", ["https://self-hosted.example/path"])).toBe(false);
  expect(isKnownTinyCloudNode("https://self-hosted.example", ["https://user@self-hosted.example"])).toBe(false);
});

test("http is refused unless it is loopback the recipient configured", () => {
  expect(isKnownTinyCloudNode("http://node.tinycloud.xyz", [node])).toBe(false);
  expect(isKnownTinyCloudNode("http://self-hosted.example", ["http://self-hosted.example"])).toBe(false);
  expect(isKnownTinyCloudNode("http://127.0.0.1:8000")).toBe(false);
  expect(isKnownTinyCloudNode("http://127.0.0.1:8000", ["http://127.0.0.1:8000"])).toBe(true);
  expect(isKnownTinyCloudNode("http://localhost:8000", ["http://127.0.0.1:8000"])).toBe(false);
  expect(isKnownTinyCloudNode("ftp://node.tinycloud.xyz", [node])).toBe(false);
});
