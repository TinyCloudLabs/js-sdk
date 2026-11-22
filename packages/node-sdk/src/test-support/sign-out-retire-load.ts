// Child process for TinyCloudNode.signOutRetire.test.ts (TC-3443). The runtime caches a loaded or failed module,
// so the load of `session-retire.ts` is staged here, in a process of its own, through a Bun plugin:
//   pending: the load waits until after sign-out; then it completes.
//   fail:    every load fails.
// A sign-in starts the load; the child signs out, waits for the node calls, and prints one JSON line.
import "../../../operations/test-support/test-bootstrap.mjs";

const mode = process.argv[2] as "pending" | "fail";
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const load = { started: 0, finished: false };
Bun.plugin({
  name: "stage-session-retire-load",
  setup(build) {
    build.onLoad({ filter: /[\\/]session-retire\.ts$/ }, async ({ path }) => {
      load.started += 1;
      if (mode === "fail") throw new Error("Loading chunk session-retire failed.");
      await gate;
      const contents = await Bun.file(path).text();
      load.finished = true;
      return { contents, loader: "ts" };
    });
  },
});

// Imported after the plugin is registered, so the plugin sees every load of `session-retire.ts`.
const { TinyCloudNode } = await import("../TinyCloudNode");
const { NodeWasmBindings } = await import("../NodeWasmBindings");
const { PrivateKeySigner } = await import("../signers/PrivateKeySigner");
const { MemorySessionStorage } = await import("../storage/MemorySessionStorage");
const { PROOF_PRIVATE_KEY } = await import("./signed-restorable-session");
const { unregisteredLocationRegistryResponse } = await import("./unregistered-location-registry");

const HOST = "https://primary.retire.test";
const retires: { iss: string; delegations: string[] }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const metadata = unregisteredLocationRegistryResponse(input, HOST, init);
  if (metadata) return metadata;
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== HOST) throw new Error("Unexpected test destination");
  if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: "did:key:primary" });
  if (url.pathname === "/delegate") return Response.json({ activated: [], skipped: [] });
  if (url.pathname === "/session/retire") {
    const authorization = new Headers(init?.headers).get("authorization")!;
    const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString("utf8"));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { delegations: string[] } : { delegations: [] };
    retires.push({ iss: payload.iss, delegations: body.delegations });
    return Response.json({ did: payload.iss.split("#")[0], retiredAt: new Date().toISOString(), recorded: true });
  }
  throw new Error("Unexpected test endpoint");
}) as typeof globalThis.fetch;

const storage = new MemorySessionStorage();
const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
const address = await signer.getAddress();
const node = new TinyCloudNode({
  host: HOST, tinycloudRegistryUrl: HOST, signer, wasmBindings: new NodeWasmBindings(),
  sessionStorage: storage, autoBootstrapAccount: false, autoCreateSpace: false,
  includeAccountRegistryPermissions: false, enablePublicSpace: false,
});
await node.signIn();
const [grant] = await node.grantRuntimePermissions([{ service: "tinycloud.kv", space: "account", path: "retire/", actions: ["tinycloud.kv/get"] }]);
const iss = node.session!.verificationMethod;
const roots = [node.session!.delegationHeader.Authorization, grant!.delegationHeader.Authorization];
const loadStartedAtSignIn = load.started > 0;

await node.signOut();
const signedOut = { session: node.session === undefined, stored: storage.exists(address), loadFinished: load.finished, retires: retires.length };
release();
const status = await node.nodeSignOutStatus();
await node.signIn();

console.log(JSON.stringify({ loadStartedAtSignIn, signedOut, status, retires, iss, roots, signedInAgain: node.session !== undefined }));
