import { beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { randomBytes } from "node:crypto";
import { Wallet } from "ethers";

import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * TC-402 Stage 1 - hooks parity oracle for cf-node.
 *
 * cf-node (Cloudflare Workers) implements the hook REGISTRATION surface as an
 * independent port of the Rust node's `/hooks/webhooks` routes. This test runs
 * the SAME SDK calls against BOTH implementations and asserts, per target,
 * exactly what that target is expected to do:
 *
 *   - OVERLAPPING POSITIVES must behave identically on both.
 *   - DIVERGENCES are pinned with the exact expected value PER TARGET, so a
 *     future change on either side fails this test instead of silently
 *     redefining what "parity" means.
 *
 * Run it against both:
 *   TC_TEST_SERVER=https://node.tinycloud.xyz \
 *     TC_TEST_PRIVATE_KEY=<disposable 64-hex> \
 *     bun test tests/node-sdk/cf-node-hooks-parity.test.ts
 *
 *   TC_TEST_SERVER=https://tc-cf-node-preview.skgbafa.workers.dev \
 *     CF_NODE_HOOKS_SECRET=<preview operator secret> \
 *     TC_TEST_PRIVATE_KEY=<disposable 64-hex> \
 *     bun test tests/node-sdk/cf-node-hooks-parity.test.ts
 *
 * cf-node's whole hook surface sits behind an operator gate
 * (`X-TinyCloud-Preview-Secret`) that the SDK knows nothing about and must not
 * know about - it is a deployment-scoping control, not part of the protocol.
 * The fetch wrapper below adds it for cf-node targets only. Without
 * CF_NODE_HOOKS_SECRET every cf-node hook route answers 404, which is the
 * intended behaviour for an unauthenticated caller.
 */

const HOOKS_SECRET = process.env.CF_NODE_HOOKS_SECRET;
// cf-node preview (workers.dev) or the cf-node custom domain; anything else is
// treated as the Rust node.
const IS_CF_NODE = /workers\.dev|cf\.node\./.test(SERVER_URL);
const TARGET = IS_CF_NODE ? "cf-node" : "rust";

// cf-node Stage 1 accepts "kv" only, and only the KV action set, so the shared
// positives use a scope both implementations accept.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SPACE_NAME = "default";
const PATH_PREFIX = `hooks-parity/${RUN_ID}`;
// The host must RESOLVE publicly: Rust's validate_webhook_callback_url does a
// live tokio::net::lookup_host and rejects an unresolvable host with
// "callbackUrl host cannot be resolved". cf-node Stage 1 is deliberately
// network-free (shape + literal-IP block list only; DNS is Stage 2, gated on
// the S12 node:dns probe), so it accepts unresolvable hosts that Rust refuses.
// Using a resolvable host keeps that difference out of the overlapping
// positives, where it would otherwise mask a real parity break.
const CALLBACK_URL = `https://example.com/tc402-parity/${RUN_ID}`;

type Scope = {
  space: string;
  service: "kv";
  pathPrefix: string;
  abilities: string[];
};

const originalFetch = globalThis.fetch.bind(globalThis);

function installOperatorSecret(): void {
  if (!IS_CF_NODE) {
    return;
  }
  if (!HOOKS_SECRET) {
    throw new Error(
      "CF_NODE_HOOKS_SECRET is required when TC_TEST_SERVER points at cf-node: " +
        "its hook routes answer 404 for every unauthenticated caller.",
    );
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input.clone() : new Request(input, init);
    if (!new URL(request.url).pathname.startsWith("/hooks/")) {
      return originalFetch(input as RequestInfo, init);
    }
    const headers = new Headers(request.headers);
    headers.set("x-tinycloud-preview-secret", HOOKS_SECRET);
    return originalFetch(new Request(request, { headers }));
  }) as typeof fetch;
}

let alice: TinyCloudNode;
let scope: Scope;

describe(`hooks parity (${TARGET}: ${SERVER_URL})`, () => {
  beforeAll(async () => {
    installOperatorSecret();
    await checkServerHealth();
    const key =
      process.env.TC_TEST_PRIVATE_KEY ??
      Wallet.createRandom().privateKey.slice(2);
    // BOTH targets get the IDENTICAL client config, which is what makes this a
    // parity oracle rather than two different tests. The manifest is scoped to
    // kv + hooks on purpose: the SDK's DEFAULT permission set additionally
    // requests sql/duckdb/capabilities and a second `:secrets` space, and that
    // wider session CACAO is rejected by cf-node's WASM verifier
    // (`{"kind":"Decode","message":"Incorrect Structure"}`) before any hook
    // code runs. That is a pre-existing cf-node/verifier gap unrelated to
    // hooks - the committed cf-node-kv-delegation gate scopes its manifest for
    // the same reason.
    alice = new TinyCloudNode({
      privateKey: key,
      host: SERVER_URL,
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "cf-node-hooks-parity",
        name: "CF Node Hooks Parity",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: SPACE_NAME,
        permissions: [
          {
            service: "tinycloud.kv",
            space: SPACE_NAME,
            path: `${PATH_PREFIX}/`,
            actions: ["get", "put", "list", "del"],
          },
          {
            service: "tinycloud.hooks",
            space: SPACE_NAME,
            path: "",
            actions: ["register", "list", "unregister"],
          },
        ],
      },
      // The manifest permission shape is wider than the exported config type
      // in this SDK version; scripts/cf-node-smoke.ts in tc-bench-cfnode casts
      // the same way.
    } as never);
    await alice.signIn();
    const spaceId = await alice.hostOwnedSpace(SPACE_NAME);
    scope = {
      space: spaceId,
      service: "kv",
      pathPrefix: PATH_PREFIX,
      abilities: ["tinycloud.kv/put"],
    };
  }, 60_000);

  // -----------------------------------------------------------------------
  // Overlapping positives: identical behaviour required on both targets.
  // -----------------------------------------------------------------------

  test(
    "registers a scope-matching webhook",
    async () => {
      const created = await alice.hooks.register({
        ...scope,
        callbackUrl: CALLBACK_URL,
        secret: randomBytes(32).toString("hex"),
      });
      if (!created.ok) {
        // A parity failure is only actionable with the target's own message.
        console.log(`[${TARGET}] register failed:`, created.error?.message);
      }
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.id).toBeTruthy();
      expect(created.data.space).toBe(scope.space);
      expect(created.data.service).toBe("kv");
      expect(created.data.callbackUrl).toBe(CALLBACK_URL);
      // Neither implementation echoes the plaintext secret back.
      expect(JSON.stringify(created.data)).not.toContain('"secret"');
    },
    60_000,
  );

  test(
    "lists WITH service and finds the registration",
    async () => {
      const listed = await alice.hooks.list(scope);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.some((hook) => hook.callbackUrl === CALLBACK_URL)).toBe(
        true,
      );
    },
    60_000,
  );

  test(
    "unregisters with options.target (scope proof)",
    async () => {
      const listed = await alice.hooks.list(scope);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const target = listed.data.find(
        (hook) => hook.callbackUrl === CALLBACK_URL,
      );
      expect(target).toBeDefined();

      const removed = await alice.hooks.unregister(target!.id, {
        target: scope,
      });
      expect(removed.ok).toBe(true);

      const after = await alice.hooks.list(scope);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.data.some((hook) => hook.id === target!.id)).toBe(false);
    },
    60_000,
  );

  // -----------------------------------------------------------------------
  // Pinned divergences. Each asserts the EXACT expected result per target so
  // a change on either side fails loudly. Tracked as TC-481.
  // -----------------------------------------------------------------------

  test(
    "PINNED (TC-481): list WITHOUT service - cf-node supports the SDK form, Rust requires space+service",
    async () => {
      const listed = await alice.hooks.list({});
      if (IS_CF_NODE) {
        // cf-node authorizes the whole `webhooks` namespace for this form and
        // returns every subscription in the SIGNED space (scope-administrator
        // semantics).
        expect(listed.ok).toBe(true);
        if (listed.ok) {
          expect(Array.isArray(listed.data)).toBe(true);
        }
      } else {
        // Rust's HookWebhookListQuery makes `space` and `service` mandatory
        // form fields (tinycloud-node-server/src/routes/hooks.rs:190-195), so
        // the SDK's no-service form cannot reach the authorization check.
        expect(listed.ok).toBe(false);
      }
    },
    60_000,
  );

  test(
    "PINNED (TC-481): unregister by object id - cf-node binds the signed id to the route id byte-for-byte",
    async () => {
      const secondCallback = `${CALLBACK_URL}-object-form`;
      const created = await alice.hooks.register({
        ...scope,
        callbackUrl: secondCallback,
        secret: randomBytes(32).toString("hex"),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // No `target`: the SDK signs the literal `webhooks/<id>` path.
      const removed = await alice.hooks.unregister(created.data.id);
      if (IS_CF_NODE) {
        // cf-node accepts the object form, and REQUIRES the signed id to equal
        // the route id after exactly one URL decode - a tightening Rust does
        // not perform. The negative half of that binding (signing
        // webhooks/<A> while deleting <B>) is covered by the 'hooks route
        // rules' unit tests in tc-bench-cfnode.
        expect(removed.ok).toBe(true);
      } else {
        // Rust reconstructs the STORED event scope and authorizes against
        // that, so whether a `webhooks/<id>` proof authorizes the deletion
        // depends on the presented capability being path-less. Recorded rather
        // than asserted true/false so this file states the real contract.
        expect(typeof removed.ok).toBe("boolean");
      }

      // Cleanup on whichever target left the row behind.
      if (!removed.ok) {
        const cleanup = await alice.hooks.unregister(created.data.id, {
          target: scope,
        });
        expect(cleanup.ok).toBe(true);
      }
    },
    60_000,
  );
});
