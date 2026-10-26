# TinyCloud Web SDK

<img src="https://github.com/TinyCloudLabs/web-sdk/blob/main/documentation/static/img/tinycloudheader.png?raw=true" alt="TinyCloud" width="100%" />

The TinyCloud Web SDK provides all the tools you need to build decentralized web applications with TinyCloud.

[![npm version](https://img.shields.io/npm/v/@tinycloud/web-sdk.svg)](https://www.npmjs.com/package/@tinycloud/web-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/TinyCloudLabs/web-sdk/blob/main/LICENSE-MIT)

## Features

- **Decentralized Storage** - Store and retrieve data using TinyCloud's storage protocol
- **Web3 Authentication** - Sign-in with Ethereum (SIWE) integration
- **Wallet Integration** - Seamless connection with popular Ethereum wallets
- **Type Safety** - Written in TypeScript with comprehensive type definitions
- **Easy to Use** - Simple API for common decentralized application needs

## Installation

```bash
# Using npm
npm install @tinycloud/web-sdk

# Using Yarn
yarn add @tinycloud/web-sdk

# Using Bun (recommended)
bun add @tinycloud/web-sdk
```

## Quick Start

```typescript
import { TinyCloudWeb } from '@tinycloud/web-sdk';

// Initialize the SDK
const tc = new TinyCloudWeb();

// Connect to the user's wallet
await tc.connect();

// Use storage
const storage = tc.storage;
await storage.put('myKey', { hello: 'world' });
const result = await storage.get('myKey');
console.log(result.data); // { hello: 'world' }
```

## Optional local KV replication

Install `@tinycloud/replica`, then load and register the optional browser plugin
**before** constructing a replication-enabled client:

```typescript
import { TinyCloudWeb, registerBrowserReplica } from '@tinycloud/web-sdk';
import { browserReplicaPlugin, loadIndexedDbReplicaStorage } from '@tinycloud/web-sdk/replica';

const indexedDbReplicaStorage = await loadIndexedDbReplicaStorage();
registerBrowserReplica(browserReplicaPlugin);
const tc = new TinyCloudWeb({
  replication: {
    enabled: true,
    prefixes: ['notes/'],
    storage: indexedDbReplicaStorage(),
  },
});
```

Importing the optional entry alone does not register loaders or touch IndexedDB.
Duplicate registration throws immediately; enabling replication without
registration throws at construction. Replication off requires no plugin, and a
refused local replica does not end an otherwise valid network session.
Set `replication.syncScope: 'prefixes'` to request sign-in sync only on the declared prefixes.
Set `replication.contentFetch: 'lazy'` to sync entry names without downloading values; reads of values the replica does not hold go to the network. The default is `'eager'`.

Use the same module format for registration and the client: importing both
ESM and CJS root bundles in one process creates independent module registries.

`signIn()` selects a persisted session for the currently connected wallet;
switching wallets starts a fresh sign-in instead of reviving the prior wallet's
session. Explicit `restoreSession(address)` can restore a valid network session,
but local replication also requires that the provider currently reports that
wallet. An unknown, unavailable, or different provider account leaves network
use intact and gates local reads; restoring never creates or repairs a replica
stamp. Local reads recheck the connected account before returning replica data.

Size accounting uses the replica-e2e **Node size job** (Bun 1.3.14,
Rust 1.99.0), an absolute web-root ceiling, and separate opt-in first-import,
activation, and worker ceilings. The historical Phase 2 allowance of
1,461,925 B ESM / 1,391,665 B CJS was measured against master `9891ed9d`
at 1,460,603 / 1,390,460 B; the reviewed fix-required row at `ddc032ca`
raised that historical ceiling to 1,462,034 / 1,391,799 B for copied-proof
restore, gated read events, durable denial, and GRANT_REVOKED projection.
The old 388 / 861 B allowance and #546/#553 ledger entries remain unchanged.
The historical file marginals are nonadditive; no synchronous TC-1208 fence moved.

GitHub's replica-e2e Node size jobs measured the **same approved shipped source**
under Bun 1.3.14 / Rust 1.99.0: master `9891ed9d` at
1,462,590 / 1,393,500 B and #548 `e5b080d5` at
1,464,102 / 1,394,869 B. The zero-headroom root ceilings are
1,464,102 / 1,394,869 B (+1,512 / +1,369 B against that CI baseline).
The earlier local 1,462,685 / 1,393,687 B baseline and
1,464,189 / 1,395,035 B candidate are recorded as **non-canonical smoke**
measurements; the prior +1,431 / +1,339 B and root ceilings remain
historical, not additive allowance. The diff from `ddc032ca` to
`2acd4ac5` changes only web size scripts, ledgers, tests and this README;
no shipped source or build input changed. The checker refuses mismatched local
Bun/Rust versions and later changes to this corrected ratchet.

The #565 fix-before-stable hardening (security L1/L2/I1 and correctness P2s)
raised these ceilings once, by the exact bytes GitHub run 39023273615 measured
after size cuts: root to 1,464,122 / 1,394,880 B (+20 / +11), first import
(+134 / +129), activation (+4 / +5) and the worker (+7). The ledger's
`hardeningRatchet` row records them and cannot change later.

The #571 sign-out contract (TC-841: the TC-721 owner revoke and the prepared-login
retry) raised only the root ceilings once more, by the exact bytes GitHub run
39054822172 measured after size cuts: to 1,464,390 / 1,395,073 B (+268 / +193).
First import, activation and the worker keep #565's ceilings. The ledger's
`logoutRatchet` row records them and cannot change later. Because the cumulative
per-PR allowance (388 B for ESM) cannot absorb that growth, #571's `entries[]`
row is zero and the row's absolute ceiling carries it, as for Phase 2.

The TC-1413 typed node retry errors (`NODE_BUSY`, `REQUEST_TIMEOUT`, `OUTCOME_UNKNOWN`
in sdk-services and their consumers, #574) raised four buckets once more, by the exact
bytes GitHub run 39099093175 measured on source `20c29611`, in both jobs, against master
`3ae17bfc`: the root to 1,464,668 / 1,395,375 B (+278 / +302), first import
`replica.cjs` to 67,139 B (+1; `replica.mjs` +0), activation to 23,105 / 24,683 B
(+30 / +28) and the worker to 820,935 B (+827, also `MAX_WORKER_GZIP_BYTES`). No
replica-owned file changed; the sdk-services and sdk-core code is bundled into each
artifact. The ledger's `tc1413Ratchet` row and the matching optional allowance record
them and cannot change later; the `entries[]` rows carry zero (root) and the measured
optional deltas.

The TC-1436 terminal marker for `disableSubDelegation` (#578) raised only the root
ceilings once more, after size cuts, by the exact bytes GitHub run 39134326448
measured on source `d8e72fb9`, in both jobs, against master `7e10709c`: to
1,465,995 / 1,395,719 B (+1,327 / +344). First import, activation, the gated artifact
and the worker keep TC-1413's ceilings. The ledger's `tc1436Ratchet` row records them
and cannot change later. If another root-growing PR lands first, #578 re-measures
against the new base and replaces its own row before it merges.

TC-1432 (vault `etag`, `ifMatch` and opt-in `expectAad` in sdk-services, #580) landed
after #578, so it was re-measured against master `129c7935` and sits on top of TC-1436's
root ceilings. It raised four buckets once, by the exact bytes GitHub run 39144311690
measured on source `83c9d75a`, identical in both jobs: the root to 1,466,908 /
1,396,591 B (+913 / +872 over TC-1436's), first import to 51,925 / 67,138 B (+1 / -1),
activation to 23,106 / 24,685 B (+1 / +2) and the worker to 822,044 B (+1,109 over
TC-1413's, also `MAX_WORKER_GZIP_BYTES`). It is #580's own row, taken after a documented
shrink attempt (see the row's `reason`). The ledger's `tc1432Ratchet` row and the
matching optional allowance record it and cannot change later; whichever PR lands after
it re-measures against the new base and updates its own row.

TC-1424 (the share receiver's non-extractable signing key, #583) landed after #580, so
it was re-measured against master `1d7b78fd` and sits on top of TC-1432's root ceilings.
It raised only the root ceilings once, by the exact bytes GitHub run 39150995159
measured on source `55145dbb`, identical in both jobs: 1,468,581 / 1,397,877 B (+1,673 /
+1,286 over TC-1432's). First import, activation, gated and the worker keep TC-1432's
ceilings. It is #583's own row, taken after a documented shrink attempt (see the row's
`reason`). The ledger's `tc1424Ratchet` row records it and cannot change later; whichever
PR lands after it re-measures against the new base and updates its own row.

TC-1448 (the `did:pkh` recipient guard for terminal grants in `TinyCloudNode.delegateTo`,
#591) landed after #583, so it was re-measured against master `1c89b697` and sits on top of
TC-1424's root ceilings. It raised only the root ceilings once, after a real shrink (it
reuses the existing terminal-grant error string), by the exact bytes GitHub run 39159867318
measured on `b8d13379` (master merged into the PR branch, source unchanged since
`18b6c9fa`), identical in both jobs: 1,468,625 / 1,397,910 B (+44 / +33 over TC-1424's).
The ledger's `tc1448Ratchet` row records them and cannot change later; whichever PR lands
after it re-measures against the new base and updates its own row.

The TC-1443 registry verdict classifier in sdk-core (#586) raised only the root
ceilings once more, after removing a duplicate secp256k1 from the bundle. It landed
after #591, so it was re-measured against master `70304c3d` and chains after
TC-1448's root ceilings. Naomi approved the row as a delta over its base (+2,368 / +61
gzip, ±50 B); GitHub run 39166751086 measured it on source `72ba295c`, identical in
both Node jobs: 1,470,995 / 1,397,981 B, i.e. +2,370 / +71 over master's measured
1,468,625 / 1,397,910 B. The row's ceilings are those measured bytes. First import,
activation, the gated artifact and the worker keep TC-1432's ceilings. The ledger's
`tc1443Ratchet` row records them and cannot change later. If another root-growing PR
lands first, #586 re-measures against the new base and replaces its own row before
it merges.

TC-1466 (a share receiver opened in several tabs at once could end up with different
signing keys, #595) landed after #586, so it sits on top of TC-1443's root ceilings. It
raised only the root ceilings once, after shrink attempts recorded in the row's `reason`,
by the exact bytes GitHub run 39172186671 measured on `b2725dd6` (master `28ca77a0`
merged into the PR branch), identical in both Node jobs: 1,471,007 / 1,397,987 B (+12 /
+6 over TC-1443's, inside the approved +12 / +6 ± 10 B). The ledger's `tc1466Ratchet` row
records them and cannot change later; whichever PR lands after it re-measures against
the new base and updates its own row.

The TC-1443 slice b registry policy (#589: the opt-in fail-closed `registryPolicy` and
its space-creation guard) raises the root ceilings once more, as an exact-delta row with
zero headroom, `tc1443bRatchet`, chained after TC-1466's. It landed after #595, so it was
re-measured on master `4a717372` (CI-measured at `f819c542`, a version commit away):
1,471,007 / 1,397,987 B, equal to TC-1466's ceilings. GitHub run 39176947473 measured the
PR on its merge commit `f65c2a0f`, identical in both Node jobs: 1,473,920 / 1,402,497 B,
i.e. +2,913 / +4,510 over master, the same delta as on the earlier base `28ca77a0`
(1,473,908 / 1,402,491 B over 1,470,995 / 1,397,981 B). Naomi approved the delta
(+2,913 / +4,510 gzip, ±50 B each, 2026-10-18). The row's ceilings are those measured
bytes. First import, activation, the gated artifact and the worker keep TC-1432's
ceilings. The ledger's `tc1443bRatchet` row records them and cannot change later. If
another root-growing PR lands first, #589 re-measures against the new base and replaces
its own row before it merges.

TC-1428 (the owner-signed artifact pin the viewer verifies for addressed artifact shares, #582) was
re-measured after #589 landed, against master `42b08909`, and sits on top of TC-1443b's root ceilings.
It raised only the root ceilings once, by the exact bytes GitHub run 39181586326 measured on source
`90f21ae6`, identical in both jobs: 1,474,835 / 1,403,309 B (+915 / +812 over TC-1443b's). First import,
activation, gated and the worker keep their ceilings. It is #582's own row, taken after a documented
shrink attempt (see the row's `reason`). The ledger's `tc1428Ratchet` row records it and cannot change
later; whichever PR lands after it re-measures against the new base and updates its own row.

TC-1476 (the debug event recorded when the account registry sync is skipped for want of account access, #600) was
measured on canonical CI against master `c7a379c5`: master 1,474,761 / 1,403,138 B, the PR on source `bf9349ed`
1,474,808 / 1,403,191 B, identical in both jobs, i.e. +47 / +53, inside Naomi's +62 B +/-20 ruling. It lowers the
root ceilings to exactly those bytes. The ledger's `tc1476Ratchet` row records it and cannot change later;
whichever PR lands after it re-measures against the new base and updates its own row.

TC-1475 (automatic retry of node 503 busy and request_timeout responses in `ServiceContext.invokeWithRetry`, which
re-signs the invocation on every attempt, plus the web-sdk and node-sdk `retryPolicy` config, #599) was measured
against master `5317cc78` and sits on top of TC-1476's root ceilings and TC-1432's first-import, activation and
worker ceilings. GitHub run 39292038037 on source `092144080` measured the same bytes in both Node jobs: root
1,475,166 / 1,403,595 B (+358 / +404 over the merge base; ceilings exactly the measured values), first import 51,925 / 67,140 B (0 / +2),
activation 23,117 / 24,699 B (+11 / +14) and the kv-storage worker 822,667 B (+623). The
ledger's `tc1475Ratchet` row records it and cannot change later;
whichever PR lands after it re-measures against the new base and updates its own row.

**Ancestry pins and squash merges.** A policy row records the PR-branch commit it
was reviewed at, and its introduction check requires that literal commit in the
PR head. js-sdk uses merge commits, which keep that commit reachable, but squash
merging is still enabled and a squash leaves it unreachable from master; ancestry
is therefore checked only when a PR introduces a row. Any
new check that re-validates merged pins against HEAD would break master again
after the next squash, and only review prevents that. As a consistency check,
every PR also requires each merged row's pin to be on its base or landed by it:
the first first-parent master commit that added the pin to `scripts/`, the merge commit
(`landingCommit` in `scripts/replica-size-policy.ts`). After a
squash merge, nothing needs editing. Content keys (blob hashes) were rejected:
pinned files such as `authority.ts` legitimately change later, whereas the
landing commit stays an ancestor for good.

The opt-in first-import ceiling is 51,925 B ESM / 67,141 B CJS gzip
(including the replica parser and noble dependencies); awaiting the IndexedDB
factory has a separate 23,117 B / 24,700 B ceiling. The content-hashed kv-storage
worker and WASM asset has a 776,128 B ceiling owned by `@tinycloud/replica`
(its `replica.worker.js`, which web-sdk does not load, has its own 770,093 B).
A compliant first local open therefore costs at most 851,170 B ESM /
867,969 B CJS incremental gzip beyond the already-loaded web root; those
assets can then be cached. These byte ceilings do not replace real-worker
Chromium acceptance of local reads, denial, expiry, and sign-out.

A refused replica admission (stale, missing, or malformed restore stamp, or
failed fresh establishment) loads a separate network-only read observer capped
at 926 B ESM / 1,014 B CJS gzip. Successful opt-ins and replica-off clients
never fetch it; sign-out uses the already-loaded authority. If this observer
cannot load, the signed network session remains usable and local reads stay gated.

The original 51,201/66,132 B first-import ceiling was a Bun toolchain
measurement correction, not adapter allowance: exact `ce52494d` built with
Bun 1.3.14 measured 51,201/66,132 B versus 45,538/65,096 B with Bun 1.4.3
on the same SDK. The approved fix-required row added 584/863 B. Subsequent
local Rust 1.99.0 rebuild measurements (+1 ESM first-import, +2/+3 B
activation) were non-canonical; GitHub's [Postgres Node size job 117262499817](https://github.com/TinyCloudLabs/js-sdk/actions/runs/38987573493/job/117262499817)
measured #548 `1873c27d` at 51,791/67,009 B first-import and
23,071/24,650 B activation, at the exact ledger ceilings.
The [replica-e2e Node size job 117166290134](https://github.com/TinyCloudLabs/js-sdk/actions/runs/38958197518/job/117166290134)
ran rustc 1.99.0 for WASM and the Phase-1 size step; the separate
[Chromium job 117166289795](https://github.com/TinyCloudLabs/js-sdk/actions/runs/38958197518/job/117166289795)
ran rustc 1.99.1 and does not set the web-root size baseline.
The [SQLite Node size job 117210798521](https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798521)
and [Postgres Node size job 117210798348](https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798348)
independently reported identical root and optional gzip bytes on `e5b080d5`;
the historical local measurements cannot set ledger ceilings.

## Floating button and panel

`TinyCloudWeb` adds a floating button and a panel to the page. The panel is rendered in an open shadow root, so host page styles do not reach it. It is not rendered inside an iframe or an opaque origin. In those cases, and with `ui: false`, nothing is added to the page.

```typescript
const tc = new TinyCloudWeb({
  ui: {
    button: true,         // default true; false hides the button only
    toasts: true,         // default true; false shows no toasts and stops the unhandled-rejection listener; prompts still render
    developerMode: false, // default false; shows the developer section
    position: "bottom-right", // "bottom-right" | "bottom-left" | "bottom-center"; each "top-*" value places at the matching bottom position; an unrecognised value falls back to "bottom-right"
    appId: "my-app",      // identity for the hide flag when no manifest is set
  },
});

tc.ui.open();
tc.ui.close();
tc.ui.toggle();
tc.ui.isOpen;    // boolean
tc.ui.available; // false in iframes, opaque origins, SSR, or when ui is false
```

`open()` also clears the user's hidden flag for the button. The hidden flag is stored per origin and app id under `tinycloud:ui:button-hidden:v1:`. The panel shows sections only for capabilities the client exposes.

### Storage section and storage-full toast

When the client exposes `storage.status()`, the panel shows a Storage section with the account's usage: "Room left", "Nearly full", "Storage is full", or "No limit", plus a bar and a "Manage storage" link. The link uses the status `manageUrl` only when it is https; otherwise it falls back to `https://account.tinycloud.xyz/storage`. When the storage needs permission, the section shows a neutral note with no numbers.

The host also watches the own-storage `storage.full` episode. While the episode is on, the button and panel show "Storage is full", and one info toast with the manage link is shown per episode, even when the panel is closed. The toast shows again only after the episode ends and a new one starts. The episode ends only on a successful write to that storage, so a status read alone does not end it.

### Toasts and notification errors

Toasts render in the host panel layer and follow the same `ui` options. `ui: false` creates no host, button, toasts, or listeners. `ui: false` refuses SDK prompts (explicit opt-in); `popups: false` and `ui: { button: false, toasts: false }` keep them. `ui: { toasts: false }` shows no toasts and stops the unhandled-rejection listener, and prompts still render. `ui.position` sets placement. Toast copy is fixed text per error kind. The raw error message is written to the console. A toast auto-dismisses after 5 seconds, at most 3 show at once, and an identical visible toast is not shown twice.

Consent and space-creation prompts render in the same open shadow root as the panel. Each is a `role="dialog"` with `aria-modal="true"`, named by its title and described by its explanation. Focus moves to the dialog itself, never to Approve or Create, so Enter alone cannot confirm consent. Tab and Shift+Tab stay inside the dialog. When a prompt closes, focus returns to the element that had it before the prompt opened, unless focus has moved elsewhere on the page. While a prompt is open the page's scroll is locked. Releasing the lock restores the page's previous `body` `overflow` value, so a page that set `overflow: clip` keeps it.

Space creation has three modes, in this order of precedence. An explicit `spaceCreationHandler` always handles the request. Otherwise `autoCreateSpace: true` creates the space without a dialog, and `autoCreateSpace: false` creates nothing and opens no dialog. When neither is set, the default confirmation dialog opens. With `ui: false` the SDK's own prompts do not render: a consent request resolves as declined and a space-creation request resolves as dismissed, with one console warning.

`notifications.throwErrors: true` rethrows the raw error message asynchronously, so global error handlers see it. Identical errors within 200 ms collapse into one throw; distinct errors each throw. It applies whenever `ui` is enabled and `ui.toasts` is not `false`, including on a framed page where the toast is dropped. It never applies with `ui: false` or `ui: { toasts: false }`. The legacy `popups`, `position`, `duration`, and `maxVisible` keys under `notifications` are removed from the TypeScript types. JavaScript callers that still pass them are mapped onto `ui` once per page load, with a console warning per key: `popups: false` becomes `ui: { button: false, toasts: false }` only when `ui` is not set. An explicit `ui` replaces that mapping as a whole, so `popups: false` with `ui: { position: 'bottom-left' }` keeps the button and toasts. `position` becomes `ui.position` unless `ui.position` is set. `duration` and `maxVisible` are ignored, and their warning says so. Migrate to `ui`.

## Basic Storage Operations

### Storing Data

```typescript
// Store a simple object
await storage.put('user/profile', {
  name: 'Alice',
  email: 'alice@example.com',
  preferences: {
    theme: 'dark',
    notifications: true
  }
});

// Store a string
await storage.put('messages/welcome', 'Welcome to the app!');

// Store binary data (as a Uint8Array)
const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
await storage.put('files/data.bin', binaryData);
```

### Retrieving Data

```typescript
// Get an object
const profileResponse = await storage.get('user/profile');
const profile = profileResponse.data;
console.log(`User name: ${profile.name}`);

// Get a string
const messageResponse = await storage.get('messages/welcome');
console.log(messageResponse.data); // "Welcome to the app!"
```

### Listing Data

```typescript
// List all keys under 'user/'
const userKeysResponse = await storage.list({
  path: 'user',
  removePrefix: true // Remove the prefix from the returned keys
});

const userKeys = userKeysResponse.data;
console.log('User keys:', userKeys); // ['profile', ...]
```

### Listing Keys That Start With a Partial Name

The node matches list prefixes on **whole path segments** (node 1.19.0, TC-731):
`list({ prefix: 'qa/b' })` returns `qa/b` and `qa/b/...`, never `qa/b00`. This is
deliberate: a list is the authorization scope, so a grant on `docs` cannot be used to
enumerate `docsecret/...`.

When you want "names starting with X" (UI type-ahead over a small folder), use the
standalone `listMatching(kv, prefix, options?)` function. It lists the folder up to the
last `/` with the normal `list`, reads **every** page, and filters client-side. It takes
`tc.kv` or a prefixed view (`tc.kv.withPrefix('notes')`), and is not part of the KV
service itself, so apps that don't import it don't ship it.

**Browser apps import it from `@tinycloud/sdk-core/kv-list-matching`** (web-sdk already
depends on sdk-core). It is a separate entry, not in any package root, so
`@tinycloud/web-sdk` and `@tinycloud/sdk-core` root bundles are unchanged:

```typescript
import { listMatching } from '@tinycloud/sdk-core/kv-list-matching';
// TypeScript: the subpath's types need `moduleResolution` node16, nodenext or
// bundler. With "node" tsc reports TS2307 (the runtime import still works).

// Keys: qa/b00, qa/b01, qa/c00
const result = await listMatching(tc.kv, 'qa/b');
if (result.ok) console.log(result.data.keys); // ['qa/b00', 'qa/b01']
```

It never lists more than the folder, so a delegated session sees only what its grant
allows, and a folder outside the grant fails exactly as `list` would. The cost is the
size of the **folder**, not the number of matches, so it is slow for large folders. For
those, give the data a real folder structure (`users/<id>/...`) and use `list`.

### Deleting Data

```typescript
// Delete a single key
await storage.delete('messages/welcome');

// Delete all data under a prefix
await storage.deleteAll('user');
```

### Automatic retry

When the node answers `503` busy (`NODE_BUSY`) or `503` request timeout (`REQUEST_TIMEOUT`), it
applied nothing, so the SDK retries on its own: up to 4 attempts in about 12 s, waiting the node's
`Retry-After` when sent, otherwise exponentially with full jitter (250 ms base, 4 s cap). It stops
early on abort or the per-request `timeout`, and returns the last typed error once the budget is
spent. `OUTCOME_UNKNOWN` is never retried. Tune or opt out with `retryPolicy`; `{ maxAttempts: 1 }`
(or `retryableErrors: []`) disables it. Monitors and probes should disable retries. A successful KV response carries
`retry: { attempts, backoffMs }`, so latency can be split from backoff. The CLI disables retries
with `--no-retry` or `TINYCLOUD_RETRY=0`, and its `kv get|put|delete --json` output reports
`attempts` and `backoffMs`.

```typescript
const tcw = new TinyCloudWeb({ retryPolicy: { maxAttempts: 1 } });
```

## Core Values

TinyCloud is built on these fundamental principles:

- **Sovereignty** - Built so that each user controls their data outright. Requests to access or compute on that data must be explicitly permissioned.
- **Privacy** - Data is stored, streamed, and computed upon in ways that minimize leakage with encryption strategies that ensure users do not need to trust an external party.
- **Interoperability** - Embracing artifact-based formats like Markdown, JSON Canvas, CSV, and SQLite so that data remains portable and future-proof.
- **Open Innovation** - We view AI's rapid growth as an opportunity to endow individuals with new capabilities—before these capabilities are seized exclusively by large institutions.

## Credential discovery

Share receivers that require a credential discover the catalog at `https://witness.credentials.org/.well-known/opencredentials` by default. Set `credentialDiscoveryUrl` in the receiver config to use a different endpoint. The URL must be `https` and must be `/.well-known/opencredentials` or `/v1/credential-types`, with no query or fragment.

If discovery responds with a 2xx status whose body is not JSON, the call rejects with an error whose `code` is `CREDENTIAL_DISCOVERY_FAILED`, carrying `host`, `status`, and `contentType`. A 503 response rejects with `ISSUER_UNREADY`. Any other non-2xx response, and a network failure, rejects with `OFFLINE`.

## Documentation

For complete documentation, please visit:

- [**TinyCloud SDK Documentation**](https://docs.tinycloud.xyz/)
- [**Guides**](https://docs.tinycloud.xyz/docs/web-sdk/guides/)
  - [Getting Started Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/getting-started)
  - [Storage Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/storage-guide)
  - [Authentication Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/authentication-guide)
- [**API Reference**](https://docs.tinycloud.xyz/docs/web-sdk/api/)
  - [TinyCloudStorage](https://docs.tinycloud.xyz/docs/web-sdk/api/tinycloudstorage)
  - [UserAuthorization](https://docs.tinycloud.xyz/docs/web-sdk/api/userauthorization)

## Examples

Check out our [examples directory](https://github.com/TinyCloudLabs/web-sdk/tree/main/examples) for complete working examples of TinyCloud SDK integration.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE-MIT](https://github.com/TinyCloudLabs/web-sdk/blob/main/LICENSE-MIT) file for details.

## Support

If you encounter any issues or have questions, please file an issue on our [GitHub repository](https://github.com/TinyCloudLabs/web-sdk/issues).

## Community

Join the TinyCloud community:

- [Twitter](https://twitter.com/TinyCloudLabs)
- [Telegram](https://t.me/+pplkv1XbbU01MDVh)