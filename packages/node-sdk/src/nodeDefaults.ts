/**
 * Node.js-specific defaults registration.
 *
 * Importing this module registers NodeWasmBindings, PrivateKeySigner, and a
 * bounded Undici-backed default fetch as default factories on TinyCloudNode,
 * so Node.js users get the same zero-config experience (e.g.,
 * `new TinyCloudNode({ privateKey: '...' })`).
 *
 * The main entry point (index.ts) imports this for side effects.
 * The /core entry point does NOT import this, keeping it free of
 * @tinycloud/node-sdk-wasm and `undici` dependencies for browser bundling.
 *
 * @packageDocumentation
 */

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { getDefaultNodeFetch } from "./transport/nodeTransport";

TinyCloudNode.registerNodeDefaults({
  createWasmBindings: () => new NodeWasmBindings(),
  createSigner: (privateKey: string, chainId?: number) => new PrivateKeySigner(privateKey, chainId),
  createDefaultFetch: () => getDefaultNodeFetch(),
});
