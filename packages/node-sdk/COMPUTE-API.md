# Compute Service — Node SDK API (worked from two concrete examples)

Status: implemented and passing a live E2E against a real `tinycloud-node`
(`skgbafa/compute-p2-a-wasm-caveat`) — see
`tests/node-sdk/compute/compute-e2e.test.ts`, 12/12 passing. This document
works the SDK/protocol API out from two demo functions, per Sam's request:
`adder` (pure, zero-permission) and `kv_add` (stateful, needs a data grant).
Both fixtures are checked in at `tests/node-sdk/compute/fixtures/*.wat`.

## TL;DR shape

```ts
// Deploy (owner only — privileged)
const dep = await alice.compute.deploy(wasmBytes, "my-fn", {
  dataGrants: [{ service: "kv", path: "counter/", ability: "tinycloud.kv/get" }],
});
// dep.data = { functionCid, routineDid, function, revision, supersededContentCid, supersededGrant }

// Grant an invoker ONLY the right to run it
const delegation = await alice.createDelegation({
  path: "my-fn",
  actions: ["tinycloud.compute/execute"],
  delegateDID: bob.did,
});
const access = await bob.useDelegation(delegation);

// Execute (invoker — zero data caps of its own)
const exec = await access.compute.execute("my-fn", { key: "counter/x", amount: 5 });
// exec.data = { functionCid, result, manifest, grantedButUnexercised, outputDestination, verification }
```

That symmetry — `deploy()` is owner/privileged, `execute()` is
invoker/ambient — is the whole point of the compute service's two-layer
permissioning model (compute-service.md §6), and it's what the two examples
below prove concretely.

---

## Example 1 — `adder`: pure, zero-permission

**Fixture** (`tests/node-sdk/compute/fixtures/adder.wat`): no host imports
at all. Sums every run of ASCII digits in the input bytes — a real,
input-driven computation, not a canned response — so `{"numbers":[1,2,3]}`
returns `{"sum":6}`.

### Deploy

```ts
const result = await alice.compute.deploy(adderWasm, "adder", {
  dataGrants: [
    { service: "kv", path: "unused/adder/", ability: "tinycloud.kv/get" },
  ],
});
```

**The one surprising thing**: even a function that will NEVER touch data
still needs a non-empty `dataGrants`. The node's MVP deploy path
(`handle_compute_deploy` in `tinycloud-node-server/src/routes/mod.rs`)
unconditionally requires an inline `D_fn` grant on every deploy —
`grant: Option<String>` is `Option` in the type, but the handler does
`grant.ok_or(400, "deploy requires an inline encoded grant")`. A UCAN
cannot encode zero capabilities either way (`Capabilities::with_actions`
over an empty map is a client-side `EmptyAbilities` error in the WASM
binding, mirroring the existing `createDelegation`). So the honest shape
for "pure" is: one inert grant the guest is guaranteed never to exercise —
proven not by `manifest.granted` being empty (it won't be), but by
`manifest.calls`/`manifest.exercised` being empty, which is the actual,
verifiable claim "this run touched no data."

Under the hood, `deploy()` does three HTTP round-trips (see
`ComputeService.deploy` in `packages/sdk-services/src/compute/ComputeService.ts`):

1. **RoutineDid handshake** — `POST /invoke` with a `tinycloud.compute/deploy`
   invocation on `<space>/compute/<contentCid>`:
   ```json
   { "action": "routine_did", "content_cid": "bafkr4if..." }
   ```
   → `{ "routine_did": "did:key:z6Mko...", "content_cid": "bafkr4if...", "space": "..." }`
   The SDK computes `contentCid` locally via the WASM `computeCid` binding
   (BLAKE3 → CID, multicodec `0x55`) — it cannot compute the routine's DID
   itself; that's a TEE/node-derived seed, hence the handshake.

2. **Mint `D_fn`** — a UCAN delegation from Alice's session to the routine
   DID, with the `computeFunctionBinding` caveat on every granted row:
   ```json
   { "computeFunctionBinding": { "functionCid": "bafkr4if..." } }
   ```
   This is the part that needed a **new WASM binding** — see "The D_fn
   crux" below.

3. **Submit deploy** — `POST /invoke` with `tinycloud.compute/deploy` on
   `<space>/compute/adder`:
   ```json
   { "action": "deploy", "function": "adder", "wasm_b64": "KG1vZHVsZ...", "grant": "<encoded D_fn>" }
   ```
   → `{ "function": "adder", "content_cid": "bafkr4if...", "routine_did": "did:key:z6Mko...", "revision": 1, "superseded_content_cid": null, "superseded_grant": null }`

Result surfaced to the caller: `{ functionCid, routineDid, function, revision, supersededContentCid, supersededGrant }`.

### Grant + execute

```ts
const delegation = await alice.createDelegation({
  path: "adder",
  actions: ["tinycloud.compute/execute"],
  delegateDID: bob.did,
});
const access = await bob.useDelegation(delegation);
const exec = await access.compute.execute("adder", { numbers: [1, 2, 3] });
```

This is the ordinary, cheap sub-delegation path — Alice's own session
already holds `tinycloud.compute/execute` (it's in the SDK's default
session grant, `ROOT_DELEGATION_ACTIONS`), so `createDelegation` is a
single fast UCAN mint, no extra round trip.

`execute()` is one `POST /invoke`:
```json
{ "action": "execute", "function": "adder", "input": { "numbers": [1, 2, 3] } }
```
Live response (captured from the E2E run):
```json
{
  "functionCid": "bafkr4if...",
  "result": { "sum": 6 },
  "manifest": { "calls": [], "exercised": [], "granted": ["tinycloud.kv/get"] },
  "grantedButUnexercised": ["tinycloud.kv/get"],
  "outputDestination": "inline",
  "verification": { "mode": "in-node", "backend": "wasmtime" }
}
```
`manifest.calls` and `manifest.exercised` are empty — that's the proof.
`granted`/`grantedButUnexercised` still show the one inert grant, exactly
as predicted above.

**Bob holds zero data capabilities, before or after.** A direct
`access.kv.get("unused/adder/x")` returns `{ ok: false }` — running the
routine never leaks the routine's authority to the invoker.

---

## Example 2 — `kv_add`: stateful, needs a data grant

**Fixture** (`tests/node-sdk/compute/fixtures/kv_add.wat`): imports the
four `tinycloud` host functions but only calls two. Takes
`{"key": "...", "amount": <uint>}`, does `storage_get(key)` (missing/null
treated as 0), adds `amount`, `storage_put(key, newValue)`, returns
`{"previous": <old>, "new": <new>}`. On a denied `storage_get` it returns
`{"denied": "tinycloud.kv/get", "key": "<key>"}` and skips the put — no
mutation on a denial.

### Deploy with a real grant

```ts
const result = await alice.compute.deploy(kvAddWasm, "kv-add", {
  dataGrants: [
    { service: "kv", path: "counter/", ability: "tinycloud.kv/get" },
    { service: "kv", path: "counter/", ability: "tinycloud.kv/put" },
  ],
});
```

Same three-step sequence as Example 1, except `D_fn` now grants two real
abilities on the `counter/` prefix instead of one inert one. This is the
whole point of `dataGrants`: it's the caller's declarative expression of
"what may this routine touch," turned into `D_fn`'s attenuation.

### Execute as a zero-cap invoker

```ts
const delegation = await alice.createDelegation({
  path: "kv-add",
  actions: ["tinycloud.compute/execute"],
  delegateDID: bob.did,
});
const access = await bob.useDelegation(delegation);

await alice.kv.put("counter/x", "10"); // seed, as the owner
const exec = await access.compute.execute("kv-add", { key: "counter/x", amount: 5 });
```

Live response:
```json
{
  "functionCid": "bafkr4ihz...",
  "result": { "previous": 10, "new": 15 },
  "manifest": {
    "calls": [
      { "ability": "tinycloud.kv/get", "resource": ".../kv/counter/x", "destination": "inline", "granted": true, "bytesIn": 19, "bytesOut": 24 },
      { "ability": "tinycloud.kv/put", "resource": ".../kv/counter/x", "destination": "counter/x", "granted": true, "bytesIn": 32, "bytesOut": 11 }
    ],
    "exercised": ["tinycloud.kv/get", "tinycloud.kv/put"],
    "granted": ["tinycloud.kv/get", "tinycloud.kv/put"]
  },
  "grantedButUnexercised": [],
  "outputDestination": "inline",
  "verification": { "mode": "in-node", "backend": "wasmtime" }
}
```

`access.kv.get("counter/x")` — Bob probing directly — returns `{ ok: false
}` both BEFORE and AFTER this call. The routine read and wrote
`counter/x` under **its own** `D_fn`; Bob's delegation never carried a kv
capability. Alice's own `alice.kv.get("counter/x")` (her ambient, unrelated
authority) reads back `15`.

### Denial (A.4 contract)

```ts
const denied = await access.compute.execute("kv-add", { key: "secret/x", amount: 1 });
```
```json
{
  "result": { "denied": "tinycloud.kv/get", "key": "secret/x" },
  "manifest": {
    "calls": [{ "ability": "tinycloud.kv/get", "resource": ".../kv/secret/x", "granted": false, "destination": "" }],
    "exercised": [],
    "granted": ["tinycloud.kv/get", "tinycloud.kv/put"]
  },
  "grantedButUnexercised": ["tinycloud.kv/get", "tinycloud.kv/put"]
}
```
Note this is HTTP `200`, not a 4xx/5xx — the denial rides inside the
routine's own result and the manifest (`calls[0].granted: false`), per the
node's "error-envelope, not a trap" contract (compute-service.md §A.4).
`alice.kv.get("secret/x")` afterward confirms the key was never created.

---

## Under the hood: two things that had to be added, and why

### 1. The D_fn caveat-minting crux (real WASM gap, fixed)

The WASM `createDelegation` (used for ordinary user-to-user sharing) hard-codes
empty caveats — `Capabilities<[(); 0]>` in
`tinycloud-sdk-wasm/src/session.rs`. There was no way to mint a delegation
carrying the `computeFunctionBinding` caveat `D_fn` requires on every row.

**Fix, not a workaround**: added a new, additive method
`Session::create_delegation_with_caveat` (+ the `createDelegationWithCaveat`
`wasm_bindgen` export) on a branch off compute-p2-a
(`skgbafa/compute-p2-a-wasm-caveat` in tinycloud-node). Same shape as
`create_delegation`, except the caveat type is `serde_json::Value` (not
`[(); 0]`) and every granted ability row carries one clone of the passed
caveat map — mirrors the node-side test helper `compute_common::mint_d_fn`
exactly. `create_delegation`/`createDelegation` and their existing callers
and tests are untouched. Validated: `cargo check -p tinycloud-sdk-wasm`
clean, `wasm-pack build --target nodejs` succeeded, symbol confirmed present
in the generated `.d.ts`/`.js`, and the full E2E now exercises it live.

This is currently the **ideal shape already**, not a fallback — the SDK
mints `D_fn` itself; the caller never sees or hand-crafts a UCAN. The one
loose end is that `packages/sdk-rs/Cargo.toml` is pinned to that node
**branch**, not a release tag, until tinycloud-node cuts a release
containing it — a deliberate, documented, temporary deviation from the
"release tags only" pin convention.

### 2. `compute/deploy` is a privileged, non-ambient capability

`compute-service.md` §12.1 (F9) requires the SDK's default session grant to
enumerate `compute/execute` and **never** `compute/deploy` (the wildcard
`compute/*` would confer both). So `deploy()` can't just use the caller's
ambient session — that session genuinely does not hold the ability, by
design, even for the space's own owner.

**Fix**: `deploy()` mints short-lived, resource-scoped elevation sessions
on demand via a new `IServiceContext.mintPrivilegedSession` primitive.
`TinyCloudNode` implements it by reusing the existing
`createOwnerDelegation` machinery (a fresh wallet-signed root delegation,
independent of the ambient session's chain — the same mechanism space
sharing already uses to grant a share key capabilities the current session
doesn't hold). One subtlety that only showed up against the live node: the
RoutineDid handshake and the deploy submission target **two different
resource paths** (`<space>/compute/<contentCid>` vs.
`<space>/compute/<name>`), and delegation containment requires the
invocation's own resource to be covered by a parent grant on that *exact*
path — so `deploy()` mints two separate elevation grants, one per path, not
one reused across both. (First attempt used one grant scoped to `name`
only; it 401'd on the handshake with `Unauthorized Action:
.../compute/<contentCid> / tinycloud.compute/deploy` until split.)

The `D_fn` mint itself (step 2) deliberately stays on the **ambient**
session, not the elevated one — `D_fn`'s proof chain must resolve to a
delegation that actually grants the data abilities being handed to the
routine (`kv/*`, `sql/*`, ...), which a `compute/deploy`-only elevation
session does not carry. This is the least-privilege split working as
intended, not an oversight.

### 3. `D_fn` expiry is bounded by the ambient session, not independent

`D_fn` is minted as a UCAN sub-delegation citing the ambient session as
proof (not a fresh wallet-root delegation), so containment rejects it if
its expiry exceeds the session's: `"Child delegation expiry exceeds parent
expiry"`. Default `D_fn` lifetime is 1 day (comfortably under the SDK's
7-day default session lifetime); pass `expirationSecs` explicitly for a
different lifetime, bounded by the caller's own session/root expiry.

---

## Summary: is this the "ideal" API, or a workaround?

Deploy/execute themselves are the ideal shape: `deploy(wasm, name,
{dataGrants})` → `{functionCid, routineDid, ...}`; `execute(name, input)` →
`{result, manifest, ...}`. The caller never touches a raw UCAN, never
hand-signs anything, never needs to know about `D_fn` as a wire concept —
`dataGrants` is the only vocabulary they need.

The two things worth flagging as "current shape, not necessarily final":

- The pin to a tinycloud-node **branch** rather than a release tag
  (temporary, tracked, reverts on release).
- `mintPrivilegedSession` doing two separate wallet-signed round-trips per
  deploy (handshake-path grant + submit-path grant) is a real latency cost
  (~250-500ms combined in local testing) that a future protocol change
  (e.g., letting one grant cover both paths, or collapsing the handshake
  into the deploy call) could remove. It is not a correctness problem —
  the E2E proves the current shape is sound — just a performance/ergonomics
  opportunity once the MVP transport (§7.2/C7 in compute-service.md, which
  already documents raw-body streaming and pre-submitted grant CIDs as
  deferred) evolves.
