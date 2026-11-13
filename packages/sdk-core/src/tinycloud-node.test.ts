import { expect, test } from "bun:test";
import { sameTinyCloudNode } from "./tinycloud-node";

const node = "https://node.tinycloud.xyz";
const tee = "https://tee.node.tinycloud.xyz";
test("production aliases match both directions without normalizing callers", () => {
  expect(sameTinyCloudNode(node, tee)).toBe(true);
  expect(sameTinyCloudNode(tee, node)).toBe(true);
  expect(sameTinyCloudNode(node + "/?q=1#x", tee + "/")).toBe(false);
  expect(sameTinyCloudNode("https://other.example/path/", "https://other.example/path")).toBe(false);
});
test("unrelated hosts, paths, credentials, ports and lookalikes cannot alias production", () => {
  for (const other of ["https://evil.example", "https://node.tinycloud.xyz.evil.example", "https://tee-node.tinycloud.xyz", "http://node.tinycloud.xyz", "https://node.tinycloud.xyz:444", node + "/path", "https://user@node.tinycloud.xyz", "invalid"]) {
    expect(sameTinyCloudNode(other, node)).toBe(false);
    expect(sameTinyCloudNode(tee, other)).toBe(false);
  }
  expect(sameTinyCloudNode("https://other.example/a", "https://other.example/b")).toBe(false);
});

test("non-production URL strings retain exact equality", () => {
  for (const [a, b] of [
    ["https://other.example/a?one", "https://other.example/a?two"],
    ["https://other.example/a#one", "https://other.example/a#two"],
    ["https://other.example/a/..", "https://other.example/"],
    ["https://other.example/%2e", "https://other.example/"],
    ["https://other.example/a", "https://other.example/./a"],
  ]) {
    expect(sameTinyCloudNode(a!, b!)).toBe(false);
    expect(sameTinyCloudNode(a!, a!)).toBe(true);
  }
});
