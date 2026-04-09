import { TinyCloudNode } from "@tinycloud/node-sdk";
import { Wallet } from "ethers";

const SERVER_URL = process.env.TC_TEST_SERVER ?? "http://localhost:9000";

// Hardhat account #0 (well-known test key), env override
const DEFAULT_KEY =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY = process.env.TC_TEST_PRIVATE_KEY ?? DEFAULT_KEY;

export async function checkServerHealth(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/info`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const info = await res.json();
    console.log(`[Server] Connected to tinycloud-node v${info.version}`);
  } catch (e) {
    throw new Error(
      `Cannot reach tinycloud-node at ${SERVER_URL}.\n` +
        `Start the server on port 9000: cd tinycloud-node && ROCKET_PORT=9000 cargo run\n` +
        `Or set TC_TEST_SERVER=https://node.tinycloud.xyz\n` +
        `Error: ${e}`,
    );
  }
}

export function createClient(name: string, key?: string): TinyCloudNode {
  const k = key ?? Wallet.createRandom().privateKey.slice(2);
  return new TinyCloudNode({
    privateKey: k,
    host: SERVER_URL,
    prefix: `sdk-test-${name}`,
    autoCreateSpace: true,
  });
}

export { SERVER_URL, TEST_KEY };
