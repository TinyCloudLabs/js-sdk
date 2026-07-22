/**
 * Compute Service E2E — live-node acceptance gate for the compute-service
 * P3-SDK stage.
 *
 * Two canonical demo fixtures (checked-in WAT, deterministic — see
 * `fixtures/adder.wat` and `fixtures/kv_add.wat`) drive the whole story:
 *
 *   PART 1 — `adder`: pure, zero-permission. Proves an invoker holding
 *   ONLY `tinycloud.compute/execute` can run a function that touches NO
 *   data at all — the manifest's `calls`/`exercised` are empty.
 *
 *   PART 2 — `kv_add`: stateful. Proves the two-layer permissioning model
 *   end to end (compute-service.md §6): the INVOKER holds only
 *   `compute/execute` and zero kv capabilities of its own (probed directly
 *   and denied, before AND after running the routine), yet the ROUTINE
 *   reads+writes a counter under its OWN deploy-time `D_fn` grant. A
 *   denial case (an out-of-grant key) proves the A.4 fail-closed contract:
 *   the guest sees a denial envelope, no mutation happens, and the owner's
 *   direct read-back confirms it.
 *
 * Real server, real WASM signing, real HTTP round-trips — no mocks. See
 * the agent's testing-guide.md for the pattern this follows.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import { TinyCloudNode, type DelegatedAccess } from "@tinycloud/node-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDER_WASM = readFileSync(join(__dirname, "fixtures/adder.wat"));
const KV_ADD_WASM = readFileSync(join(__dirname, "fixtures/kv_add.wat"));

describe("Compute Service E2E", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-compute", TEST_KEY);
    console.log("[Alice] Signing in...");
    await alice.signIn();
    console.log(`[Alice] Space: ${alice.spaceId}`);
  });

  // PART 1: adder — pure, zero-permission function.
  describe("PART 1: adder (pure, zero-permission)", () => {
    const FN = `adder_${Date.now()}`;
    let bob: TinyCloudNode;
    let access: DelegatedAccess;

    test("[Alice] deploys adder", async () => {
      // The node's MVP deploy path (handle_compute_deploy) always requires
      // an inline D_fn -- a UCAN cannot encode zero capabilities -- so even
      // this pure function needs one grant. It's inert: adder makes zero
      // host calls, so it's never exercised (see PART 1's manifest
      // assertions below, and ComputeService.deploy's INVALID_INPUT
      // message for the full explanation).
      const result = await alice.compute.deploy(ADDER_WASM, FN, {
        dataGrants: [
          { service: "kv", path: "unused/adder/", ability: "tinycloud.kv/get" },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log(
        `[Alice] adder deployed: function=${result.data.function} cid=${result.data.functionCid} routineDid=${result.data.routineDid}`,
      );
      expect(result.data.function).toBe(FN);
      expect(result.data.routineDid.startsWith("did:key:")).toBe(true);
    });

    test("[Alice] delegates compute/execute (ONLY) to Bob", async () => {
      bob = createClient("bob-compute-adder");
      console.log("[Bob] Signing in...");
      await bob.signIn();
      console.log("[Bob] DID:", bob.did);

      const delegation = await alice.createDelegation({
        path: FN,
        actions: ["tinycloud.compute/execute"],
        delegateDID: bob.did,
      });
      console.log("[Alice] Delegated compute/execute:", delegation.cid);
      access = await bob.useDelegation(delegation);
    });

    test("[Bob] runs adder — holds no data caps, needs none", async () => {
      const result = await access.compute.execute(FN, { numbers: [1, 2, 3] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log("[Bob] adder result:", result.data.result);
      expect(result.data.result).toEqual({ sum: 6 });
      // The proof: this run touched NO data at all.
      expect(result.data.manifest.calls).toHaveLength(0);
      expect(result.data.manifest.exercised).toHaveLength(0);
    });

    test("[Bob] holds zero KV capabilities of his own", async () => {
      const probe = await access.kv.get("unused/adder/x");
      expect(probe.ok).toBe(false);
    });
  });

  // PART 2: kv_add — stateful, exercises the two-layer permissioning model.
  describe("PART 2: kv_add (stateful, two-layer permissioning)", () => {
    const FN = `kv_add_${Date.now()}`;
    const COUNTER_KEY = "counter/x";
    let bob: TinyCloudNode;
    let access: DelegatedAccess;

    test("[Alice] seeds counter/x = 10", async () => {
      const result = await alice.kv.put(COUNTER_KEY, "10");
      expect(result.ok).toBe(true);
    });

    test("[Alice] deploys kv_add with a D_fn granting kv/get+kv/put on counter/", async () => {
      const result = await alice.compute.deploy(KV_ADD_WASM, FN, {
        dataGrants: [
          { service: "kv", path: "counter/", ability: "tinycloud.kv/get" },
          { service: "kv", path: "counter/", ability: "tinycloud.kv/put" },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log(
        `[Alice] kv_add deployed: function=${result.data.function} routineDid=${result.data.routineDid}`,
      );
    });

    test("[Alice] delegates compute/execute (ONLY) to Bob", async () => {
      bob = createClient("bob-compute-kvadd");
      await bob.signIn();
      console.log("[Bob] DID:", bob.did);

      const delegation = await alice.createDelegation({
        path: FN,
        actions: ["tinycloud.compute/execute"],
        delegateDID: bob.did,
      });
      access = await bob.useDelegation(delegation);
    });

    test("[Bob] holds zero KV caps BEFORE running the routine", async () => {
      const probe = await access.kv.get(COUNTER_KEY);
      expect(probe.ok).toBe(false);
    });

    test("[Bob] runs kv_add — the ROUTINE reads+writes under its OWN D_fn", async () => {
      const result = await access.compute.execute(FN, {
        key: COUNTER_KEY,
        amount: 5,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log("[Bob] kv_add result:", result.data.result);
      expect(result.data.result).toEqual({ previous: 10, new: 15 });

      const exercised = new Set(result.data.manifest.exercised);
      expect(exercised.has("tinycloud.kv/get")).toBe(true);
      expect(exercised.has("tinycloud.kv/put")).toBe(true);
      expect(result.data.manifest.calls).toHaveLength(2);
      console.log("[Bob] manifest exercised:", [...exercised]);
    });

    test("[Bob] STILL holds zero KV caps AFTER running the routine", async () => {
      const probe = await access.kv.get(COUNTER_KEY);
      expect(probe.ok).toBe(false);
    });

    test("[Alice] reads back counter/x = 15 directly, under her OWN authority", async () => {
      const result = await alice.kv.get<string>(COUNTER_KEY);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(String(result.data.data)).toBe("15");
    });

    test("[Bob] denial: kv_add on a key OUTSIDE the grant fails closed, no mutation", async () => {
      const result = await access.compute.execute(FN, {
        key: "secret/x",
        amount: 1,
      });
      // A.4 denial contract: the compute request itself returns 200 — the
      // denial is surfaced IN the routine's result, not as an opaque 5xx.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log("[Bob] denied-key result:", result.data.result);
      expect(result.data.result).toEqual({
        denied: "tinycloud.kv/get",
        key: "secret/x",
      });

      // The owner's direct read-back proves no mutation ever happened: the
      // key still doesn't exist.
      const readback = await alice.kv.get("secret/x");
      expect(readback.ok).toBe(false);
    });
  });
});
