import { TinyCloudNode } from "@tinycloud/node-sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";

export const SERVER_URL =
  process.env.TC_TEST_SERVER ?? process.env.TINYCLOUD_URL ?? "http://localhost:8000";

export function freshPrivateKey() {
  return randomBytes(32).toString("hex");
}

export const OWNER_PRIVATE_KEY = process.env.TC_TEST_PRIVATE_KEY ?? freshPrivateKey();

export async function checkServerHealth() {
  const endpoints = ["/info", "/version"];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${SERVER_URL}${endpoint}`);
      if (!response.ok) {
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const info = await response.json();
        return info;
      }

      return { endpoint, body: await response.text() };
    } catch {
      // try next endpoint
    }
  }

  throw new Error(
    `Cannot reach tinycloud-node at ${SERVER_URL}.\n` +
      `Start a local node or set TC_TEST_SERVER=https://node.tinycloud.xyz`
  );
}

export function createClient(name, privateKey) {
  if (!privateKey) {
    throw new Error(`Missing private key for ${name}`);
  }

  return new TinyCloudNode({
    privateKey,
    host: SERVER_URL,
    prefix: `vfs-${name}`,
    autoCreateSpace: true,
  });
}

export function createRunId() {
  return randomUUID().slice(0, 8);
}

export function createMountPath(runId, name) {
  return pathPosix.join("/tmp", "tinycloud-vfs", runId, name);
}

export async function safeDeleteKey(node, key) {
  try {
    await node.kv.delete(key);
  } catch {
    // Ignore cleanup failures in live tests.
  }
}

export async function cleanupKeys(node, keys) {
  for (const key of keys) {
    await safeDeleteKey(node, key);
    await safeDeleteKey(node, `.tcvfs-meta/${key}`);
  }
}
