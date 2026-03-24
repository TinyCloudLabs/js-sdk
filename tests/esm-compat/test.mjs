/**
 * ESM compatibility smoke test.
 *
 * This must be run with Node (NOT Bun) to exercise Node's strict ESM resolver,
 * which requires file extensions on relative imports. If the build emits
 * extensionless imports this will fail.
 *
 * Usage: node tests/esm-compat/test.mjs
 */

// Test sdk-core — this is the primary package we're fixing
import { TinyCloud } from "@tinycloud/sdk-core";
console.log("sdk-core: OK", typeof TinyCloud);

// Test sdk-services
import { ServiceContext } from "@tinycloud/sdk-services";
console.log("sdk-services: OK", typeof ServiceContext);

// Test node-sdk — may fail if node-sdk-wasm isn't built (requires Rust toolchain)
try {
  const nodeSdk = await import("@tinycloud/node-sdk");
  console.log("node-sdk: OK", typeof nodeSdk.TinyCloudNode);
} catch (e) {
  if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.includes("node-sdk-wasm")) {
    console.log("node-sdk: SKIPPED (node-sdk-wasm not built — requires Rust toolchain)");
  } else {
    console.error("node-sdk: FAIL", e.message);
    process.exit(1);
  }
}
