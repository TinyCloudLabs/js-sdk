import { expect, test } from "bun:test";
import { sameTinyCloudNode } from "./tinycloud-node";

const node = "https://node.tinycloud.xyz";
const tee = "https://tee.node.tinycloud.xyz";
test("production aliases match both directions with existing URL normalization", () => {
  expect(sameTinyCloudNode(node, tee)).toBe(true);
  expect(sameTinyCloudNode(tee, node)).toBe(true);
  expect(sameTinyCloudNode(node + "/?q=1#x", tee + "/")).toBe(true);
  expect(sameTinyCloudNode("https://other.example/path/", "https://other.example/path")).toBe(true);
});
test("unrelated hosts, paths, credentials, ports and lookalikes cannot alias production", () => {
  for (const other of ["https://evil.example", "https://node.tinycloud.xyz.evil.example", "https://tee-node.tinycloud.xyz", "http://node.tinycloud.xyz", "https://node.tinycloud.xyz:444", node + "/path", "https://user@node.tinycloud.xyz", "invalid"]) {
    expect(sameTinyCloudNode(other, node)).toBe(false);
    expect(sameTinyCloudNode(tee, other)).toBe(false);
  }
  expect(sameTinyCloudNode("https://other.example/a", "https://other.example/b")).toBe(false);
});
