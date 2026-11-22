# TC-3547 handoff note (worktree-local)

- Builder: Opus agent for Naomi (Paseo `752f0c85-daf8-4193-b6c6-f503149e88b8`), Rocinante.
- Ticket: TC-3547 (P1, Urgent-High). Linear: https://linear.app/tinycloud-labs/issue/TC-3547/
- Design: `/var/tmp/tc3547-design.md` on the Rocinante (FINAL-3547-scope locked by Naomi 2026-11-21 12:56:17Z; refinements 12:56:44Z + 12:56:55Z + 13:04:55Z).
- Branch: `tc-3547-first-party-publish-location` (not `fix/tc-3547-*` because `bin/wt` dropped the prefix; local-only, PR body references TC-3547). Base: `origin/master` (HEAD `cb3edeab4`; identical to `f7428c208` for every file this ticket touches).
- Worktree path: this directory, `/home/tinycloud/github/tinycloud-dev/worktrees/js-sdk/tc-3547-first-party-publish-location`.

## Scope (locked)

New `@tinycloud/web-sdk` surface `ensureOwnerRegistryRecord` called from `tcw.ts._init` after sign-in succeeds. First-party only; publishes only when the owner's `did:pkh` is `unregistered`; never overwrites; verified node identity only (no caller override); publish failure never fails sign-in; logs carry no signature or full record. Consent is an app-rendered modal plus wallet `personal_sign` / OpenKey `signMessage`. A declined publish persists in the account-registry KV at `system/registry-publish/dismissed/v1`. `AccountSetupRequiredError`'s default message now names TinyCloud One and ends with the error's `setupUrl` (`https://tinycloud.one/?finish-setup=registry`); the host app can still pass its own `setupInstruction` to the constructor.

## Files expected to change

- `packages/web-sdk/src/modules/tcw.ts` — add `ensureOwnerRegistryRecord`, `_init` hook, `onRegistryPublishConsent` and `onRegistryPublishError` config fields, one extra export.
- `packages/web-sdk/src/registry-publish.ts` (new) — owner-signer chooser (`BrowserWalletSigner.signMessage` for local wallets, OpenKey `signMessage` for OpenKey owners).
- `packages/web-sdk/src/registry-publish-dismissed.ts` (new) — typed read/write of the dismissed flag in the account-registry KV.
- `packages/web-sdk/tests/*` — unit + integration per design §4.
- `packages/sdk-core/src/account-setup.ts` — add public `setupInstruction` on `AccountSetupRequiredError` (default kept as today's single-line message; backward-compatible).
- Changeset: `.changeset/tc-3547-first-party-publish-location.md` — minor on `@tinycloud/web-sdk`, minor on `@tinycloud/sdk-core`. `Details: TC-3547`.

## Followups filed (do not touch here)

- TC-3626 — OpenKey renders location-record payloads plainly so TC-3547's OpenKey consent is one screen (needs Sam's card + Naomi GO).
- TC-3627 — Registry accepts session-key publication with a sign-in SIWE's ReCap grant (zero-prompt variant; registry-server owner).
- TC-3628 — Account deletion does not remove the registry location record (privacy family, P2, Monica's gaps row).
- TC-3620 — Sam's "moment-of-need" product question; carries Bobbie's conditions for the eventual in-context flow.
- TC-3625 — OpenKey signMessage plainly / first-party restriction; subsumed by TC-3626 (a).

## Guardrails (acknowledged)

- Never merge; never push to master/main; never dispatch workflows; never publish. Draft PR to Bobbie (`19c3df87`) only.
- No production writes. Loopback registry and loopback node only for tests.
- No `export`/`printenv`/`env`/`set`/`declare -p` without args. Never echo a secret. No `export -n`.
- No Cloudflare / wrangler calls.
- Linear TC-3547 state: In Progress, Urgent-High. AI label added.

## Loopback OpenKey check (Bobbie Q1 inference)

Sign a real `canonicalLocationPayloadV2` through OpenKey's `signMessage` (`packages/sdk/src/index.ts:1161` on OpenKey main) and verify with `verifyLocationRecordV2`. If OpenKey refuses it, flip TC-3626 to blocker and ship wallet-only for 11-22.

## 2026-11-21 second commit (owed items from the draft PR body)

- Added unit tests: `packages/web-sdk/src/registry-publish.test.ts` (8 cases, all four outcomes + `onConsent` = false persists dismissed + `ignoreDismissed` bypass + signer-subject mismatch + primary space missing) and `packages/web-sdk/src/registry-publish-dismissed.test.ts` (4 cases). 16 passing including the sdk-core tests.
- Mid-day addendum folded in: `AccountSetupRequiredError.setupUrl` carries `?finish-setup=registry` by default; `ensureOwnerRegistryRecord({ ignoreDismissed: true })` bypasses the dismissed flag but preserves every other guard (unregistered-only, verified node identity, consent required, no overwrite). Host-side conditions 3 & 4 are documented on the method's JSDoc: host page needs `frame-ancestors 'self'` and must strip the query via `history.replaceState` after reading it.
- `tsconfig.json` on web-sdk now excludes `src/**/*.test.ts` so webpack's ts-loader doesn't try to compile bun-test files into the bundle.
- OpenKey loopback check (Bobbie Q1 inference) resolved SOURCE-LEVEL from OpenKey main `repositories/openkey@911925f0`: `signMessage` is contractually byte-exact ("OpenKey never rewrites their bytes", `packages/sdk/src/index.ts:1159-1174`), the widget's SIWE parser doesn't refuse non-SIWE messages (`apps/web/src/lib/exact-message-surfaces-mounted.test.ts:213`), and the signed EIP-191 result verifies cleanly through `verifyLocationRecordV2`. Reported to Naomi 13:17Z+; no scope cut needed, both wallet and OpenKey covered on 11-22.
- OpenKey driver `664ddfba` (Naomi 13:24:30Z) has a separate P1 to fix OpenKey authorize-sign's skipped new-account bootstrap. The integration acceptance test for TC-3547 uses a wallet account so it does not depend on that fix. Full OpenKey end-to-end coverage lands as a follow-up commit once `664ddfba` merges; the dependency is named here and in the PR body.

## 2026-11-21 third commit (AccountSetupRequiredError text update)

- `AccountSetupRequiredError.setupUrl` → `https://tinycloud.one/?finish-setup=registry` (Home 302s here with the query preserved; verified by `curl -I https://home.tinycloud.xyz/?finish-setup=registry`).
- Default message now reads: `Finish setting up your TinyCloud account in TinyCloud One, then sign in to this app again: ${setupUrl}`. Host apps can still pass their own `setupInstruction`.
- Changeset updated to name TinyCloud One, add the upgrading note, and end `Details: TC-3547`.
- Account-setup unit tests pin the new URL and message. Under the written test-ruling (2026-11-21), only expected strings change; no assertion is removed or loosened.

## 2026-11-22 rework (registry-record signing limited to TinyCloud One and Home)

- OpenKey refuses registry-record signatures for any origin but `https://tinycloud.one`, `https://app.tinycloud.one` and `https://home.tinycloud.xyz`. The SDK no longer asks from other hosts.
- Removed: the sign-in auto-publish hook, `onRegistryPublishConsent`, the consent preview and the dismissed flag (`registry-publish-dismissed.ts` and `ignoreDismissed`). Calling `ensureOwnerRegistryRecord()` is the consent.
- `ensureOwnerRegistryRecord()` returns `"published" | "already-current" | "needs-one" | "unavailable"` (`RegistryPublishOutcome`, exported from `@tinycloud/web-sdk`). `needs-one` = no record and this host cannot publish, or OpenKey answered `registry_record_sign_refused` / `REGISTRY_RECORD_SIGN_REFUSED`.
- Still create-only: nothing here updates an existing record, so the stored+1 rule is not exercised.
- Host order: One and Home must ship an SDK with this method before any other host hands people to One.
