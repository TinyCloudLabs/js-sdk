# Pre-release security checks: required checks and environment spec

Spec for the repository admin (Amos). Nothing here changes settings by itself;
the workflows only add checks and `environment:` lines. Read-only state below
was taken with `gh api` on 2026-11-22.

## Checks this adds

| Check (context) | Workflow | Runs on | What fails it |
|---|---|---|---|
| `gitleaks` | `.github/workflows/secret-scan.yml` | every PR (PR commits only, against the BASE commit's `.gitleaksignore`/`.gitleaks.toml`, `gitleaks:allow` ignored), every push to master (whole history against `.gitleaksignore`) | a secret-shaped value not in the reviewed baseline; a new baseline entry lands in its own baseline-only PR |
| `dependency-review` | `.github/workflows/dependency-review.yml` | every PR | a PR that adds or upgrades to a dependency version with a high or critical advisory |
| `Major release sign-off` | `.github/workflows/major-release-guard.yml` (existing) | every PR | a major changeset or major bump without an `approve-major-release:` commit |

None has a `paths:` filter, so each reports on every PR and can be required.

The npm tarball audit (`.github/scripts/audit-npm-tarballs.mjs`) is not a
status check: it is a step in every publishing job of `changesets.yml` (Beta
Release, Beta Resume, Stable Release), after the build and before the version
commit is pushed or anything is published. A finding fails the release job.

## Ruleset change: "Protect master" (id 13730837)

Naomi's rule: make a check required only after it has passed once on master.
`gitleaks` runs on push to master, so wait for its first green master run.
`dependency-review` and `Major release sign-off` run only on pull requests;
require them after each has passed on a PR into master once this change has
merged. `Major release sign-off` already passes on master PRs (e.g. #1104,
[run](https://github.com/TinyCloudLabs/js-sdk/actions/runs/44768833077/job/136400710296)).

The three new contexts pin `integration_id` 15368 (GitHub Actions), so a commit
status from another source cannot satisfy them. The existing seven are left as
they are.

### Before (`gh api repos/TinyCloudLabs/js-sdk/rulesets/13730837`, PUT-ready fields)

```json
{
  "name": "Protect master",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "exclude": [], "include": ["~DEFAULT_BRANCH"] } },
  "bypass_actors": [{ "actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Build and lint the whole workspace" },
          { "context": "Run web-sdk test files" },
          { "context": "authority" },
          { "context": "conformance" },
          { "context": "diff" },
          { "context": "Replica (Node 22, Bun 1.3.14, sqlite node)" },
          { "context": "Replica (Node 22, Bun 1.3.14, postgres node)" }
        ]
      }
    }
  ]
}
```

The live ruleset also reports `dismissal_restriction` and
`require_extra_approval_for_unattributed_changes: true` under `pull_request`.
Fetch it fresh before applying and keep every field it returns; the only
change is the `required_status_checks` list.

### After

Identical to Before, except `required_status_checks` becomes:

```json
"required_status_checks": [
  { "context": "Build and lint the whole workspace" },
  { "context": "Run web-sdk test files" },
  { "context": "authority" },
  { "context": "conformance" },
  { "context": "diff" },
  { "context": "Replica (Node 22, Bun 1.3.14, sqlite node)" },
  { "context": "Replica (Node 22, Bun 1.3.14, postgres node)" },
  { "context": "gitleaks", "integration_id": 15368 },
  { "context": "dependency-review", "integration_id": 15368 },
  { "context": "Major release sign-off", "integration_id": 15368 }
]
```

Apply:

```sh
gh api repos/TinyCloudLabs/js-sdk/rulesets/13730837 \
  | jq '{name, target, enforcement, conditions, bypass_actors, rules}' > before.json
jq '(.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks) += [
      {"context": "gitleaks", "integration_id": 15368},
      {"context": "dependency-review", "integration_id": 15368},
      {"context": "Major release sign-off", "integration_id": 15368}]' before.json > after.json
gh api -X PUT repos/TinyCloudLabs/js-sdk/rulesets/13730837 --input after.json
```

Undo: `gh api -X PUT repos/TinyCloudLabs/js-sdk/rulesets/13730837 --input before.json`.

## Environment change: publish credentials only in `production`

Ruling (Naomi, 2026-11-22 10:05Z): deploy and publish tokens live only in
master-limited `production` environments.

### Before: every secret js-sdk workflows can read (names only)

Taken with `gh api` on 2026-11-22. "Env?" says whether the job that reads the
secret declares `environment: production` on master today.

**Repository secrets** (readable by a workflow on any branch, including a PR
branch pushed to this repository):

| Secret | Updated | Read by (workflow / job) | Env? | Purpose |
|---|---|---|---|---|
| `GH_TOKEN` | 2026-03-14 | `manual-release.yml` / `release` (checkout token, `git push` remote URL, `GITHUB_TOKEN` for the release script) | no | push + GitHub release for the legacy manual release (last run 2026-04-09, failed) |
| `RELEASE_DEPLOY_KEY` | 2026-10-17 | `changesets.yml` / `beta`, `stable` (`.github/scripts/release-deploy-key.sh`) | no | SSH deploy key (id 166801705, write) that pushes version commits to master; bypasses the ruleset as `DeployKey` |
| `TC_MCP_INTROSPECTION_CLIENT_ID` | 2026-10-26 | `mcp-image.yml` / `deploy` | yes | shadowed: `production` has an environment secret of the same name, which wins |
| `TC_MCP_INTROSPECTION_CLIENT_SECRET` | 2026-10-26 | `mcp-image.yml` / `deploy` | yes | shadowed, as above |

There is also an organization `GH_TOKEN` (visibility `selected`), but js-sdk is
not among its repositories, so `secrets.GH_TOKEN` here is the repository secret
alone. No repository Dependabot secrets.

**Organization secrets visible to js-sdk:**

| Secret | Org visibility | Read by (workflow / job) | Env? |
|---|---|---|---|
| `NPM_TOKEN` | `all` | `changesets.yml` / `beta`, `beta-resume`, `stable`; `raw-publish.yml` / `publish`; `npm-latest-rollback.yml` / `rollback`; `manual-release.yml` / `release` | no |
| `NPM_CONFIG_TOKEN` | `selected` | nothing in js-sdk | n/a |
| `DISPATCH_TOKEN` | `selected` | nothing in js-sdk | n/a |
| `CLOUDFLARE_ACCOUNT_ID` | `all` | nothing in js-sdk (an account id, not a credential) | n/a |

**Environment `production`** (branch policy: `master` only; no required
reviewers): `BETTERSTACK_SOURCE_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`PHALA_CLOUD_API_KEY`, `TC_MCP_INTROSPECTION_CLIENT_ID`,
`TC_MCP_INTROSPECTION_CLIENT_SECRET`, `TC_MCP_NATIVE_SERVICE_CREDENTIAL`,
`TC_MCP_STATE_SECRET`; read by `mcp-image.yml` `preflight` and `deploy`, which
both declare it. Environment `github-pages`: no secrets.

**Publish jobs and what they read** (none declares an environment today):

| Workflow / job | Trigger | Secrets |
|---|---|---|
| `changesets.yml` / `beta` | push to master | `NPM_TOKEN`, `RELEASE_DEPLOY_KEY` |
| `changesets.yml` / `beta-resume` | dispatch (`resume: beta`) | `NPM_TOKEN` |
| `changesets.yml` / `stable` | dispatch (`confirm: release`) | `NPM_TOKEN`, `RELEASE_DEPLOY_KEY` |
| `raw-publish.yml` / `publish` | dispatch, any branch | `NPM_TOKEN` |
| `npm-latest-rollback.yml` / `rollback` | dispatch (refuses non-master in a step) | `NPM_TOKEN` |
| `manual-release.yml` / `release` | dispatch, any branch | `NPM_TOKEN`, `GH_TOKEN` |

### After

**Where #1130 expects the publish tokens: environment secrets in the
`production` environment of TinyCloudLabs/js-sdk,** named `NPM_TOKEN`,
`RELEASE_DEPLOY_KEY` and `GH_TOKEN`. Not repository secrets and not
organization secrets. The workflows keep reading `secrets.<NAME>`; with
`environment: production` on the job, GitHub resolves the environment secret
first.

- The six publish jobs declare `environment: production` (the last workflow
  commit of this PR). They then run only from `master`; a dispatch from another
  branch is refused by the branch policy before any step runs. This is
  intended (Bobbie, 10:20Z): `raw-publish.yml` last ran from
  `fix/cli-1.7.0-release-base` (2026-11-19), and that is no longer possible. A
  branch release becomes a master release, or Naomi grants an explicit
  exception that adds the branch to the `production` branch policy for that
  release and removes it afterwards.
- Environment `production` (exists: `master` only, no reviewers; keep it so)
  holds, in addition to today's secrets:
  - `NPM_TOKEN`: a new npm granular token, publish rights on the `@tinycloud`
    scope only;
  - `RELEASE_DEPLOY_KEY`: a new deploy key pair, public half a write deploy
    key, private half here;
  - `GH_TOKEN`: only if `manual-release.yml` is kept (it last ran 2026-04-09
    and failed; deleting that workflow instead removes the need for the token).
- No repository secrets remain: `GH_TOKEN`, `RELEASE_DEPLOY_KEY`,
  `TC_MCP_INTROSPECTION_CLIENT_ID`, `TC_MCP_INTROSPECTION_CLIENT_SECRET`
  deleted (the last two are already shadowed by `production`). Old deploy key
  166801705 removed.
- Organization secrets: no change in this plan. Org `NPM_TOKEN` stays
  visibility `all` for now; changing its visibility needs its value, so it is
  folded into the GO BH new-token step (Naomi and Sam). Once that step has
  narrowed it, the `production` environment secret is the only `NPM_TOKEN`
  js-sdk reads.

### Order (Naomi, 2026-11-22 10:12Z)

The publish path (tarball audit, environment) and the npm credential must not
change at once, so this PR stays open until step 2. All commands are run by
Amos; values are entered at the prompt or from a file and never echoed.

1. With master as it is today, the new npm token is used for the first
   successful beta publish (`@tinycloud/cli` 1.9.0-beta.0 / SDK
   3.14.0-beta.1). On today's master the jobs have no environment, so that run
   reads the repository or organization `NPM_TOKEN`.
2. Put the publish tokens in `production` (confirm the environment first:
   `gh api repos/TinyCloudLabs/js-sdk/environments/production`, branch policy
   `master`, no reviewers):
   ```sh
   R=TinyCloudLabs/js-sdk
   gh secret set NPM_TOKEN --env production -R "$R"          # same new token as step 1
   d=$(mktemp -d)                                              # umask 077
   ssh-keygen -q -t ed25519 -N '' -C js-sdk-release-2026-11 -f "$d/id"
   gh repo deploy-key add "$d/id.pub" -R "$R" --allow-write --title release-deploy-key-2026-11
   gh secret set RELEASE_DEPLOY_KEY --env production -R "$R" < "$d/id"
   rm -rf "$d"
   gh secret set GH_TOKEN --env production -R "$R"           # only if manual-release.yml stays
   ```
   Master is unaffected: its jobs declare no environment yet and keep reading
   the repository and organization secrets.
3. Merge this PR. The next beta run publishes with the `production` secrets,
   after the tarball audit, and pushes with the new deploy key.
4. After that run is green, remove the old copies:
   ```sh
   gh secret delete RELEASE_DEPLOY_KEY -R "$R"
   gh secret delete GH_TOKEN -R "$R"
   gh secret delete TC_MCP_INTROSPECTION_CLIENT_ID -R "$R"
   gh secret delete TC_MCP_INTROSPECTION_CLIENT_SECRET -R "$R"
   gh repo deploy-key delete 166801705 -R "$R"
   ```
   Revoke the old `GH_TOKEN` at its issuer. The old npm token and the org
   `NPM_TOKEN` visibility belong to the GO BH new-token step, not to this
   plan. Then add the required checks (ruleset section above).

### Undo

- After step 2 only: `gh secret delete <NAME> --env production -R "$R"` for
  each secret added, and `gh repo deploy-key delete <new id> -R "$R"`. Master is
  unchanged.
- After step 3: revert the `environment: production` commit; the jobs read the
  repository and organization secrets again (still present until step 4).
- After step 4: revert the `environment: production` commit, recreate the
  repository secrets (`gh secret set <NAME> -R "$R"`): `GH_TOKEN` with the step 2
  token, `RELEASE_DEPLOY_KEY` with a fresh deploy key pair made as in step 2
  (its private half was not kept). The revoked old values are not restored.
  The environment secrets can stay; only jobs that name the environment read
  them.

## Org level (not applied): a PR editing the check itself

On `pull_request`, GitHub runs `secret-scan.yml` and
`.github/actions/install-gitleaks` from the PR head, so a PR can edit the
check and pass `gitleaks`. The edit is visible in the diff; the threat model
is accidental leaks, so this is low priority (Bobbie, 10:31Z). Two options,
either or both. TinyCloudLabs is on the GitHub Team plan (5 seats), which has
both.

**A. Org ruleset, "Require workflows to pass before merging".** On Team since
[2025-06-16](https://github.blog/changelog/2025-06-16-organization-rulesets-now-available-for-github-team-plans/).
The ruleset names a source repository, workflow path and ref (pin a SHA); GitHub
runs that copy on every PR into the targeted branches, so the PR cannot edit it.
- Org: one public source repository (e.g. `TinyCloudLabs/.github`) holds the
  scan workflow; an org ruleset targets each repo's default branch. A public
  source workflow can run in public and private repositories.
- Each repo: nothing to add; its own `secret-scan.yml` can stay or go. Changes
  to the scan become PRs to the source repository plus a ref bump in the
  ruleset.
- Catches: the rule blocks direct pushes to the targeted branch. The release
  jobs push version commits to master with the deploy key, so the org ruleset
  needs a bypass that covers them (repo rulesets bypass `DeployKey`; check that
  the org ruleset offers the same before enforcing, or start in "Evaluate"
  mode). The workflow's `paths`/`branches` filters are ignored.

**B. CODEOWNERS plus "Require review from Code Owners".** Available on Team
for public and private repositories.
- Each repo: `.github/CODEOWNERS` lines such as
  `/.github/ @TinyCloudLabs/security` and `/.gitleaksignore @TinyCloudLabs/security`
  (the team needs write access), and `require_code_owner_review: true` in its
  ruleset's `pull_request` rule (js-sdk today: `false`, 0 approvals), or one
  org ruleset that sets it for every repo.
- Consequence: every PR touching `.github/` (workflows, release scripts) or
  the baseline waits for a code owner's approval, and the approver must be a
  different account from the PR author. With agents opening PRs, that is a
  human or a separate reviewer account on every CI change.

A protects the check without slowing PRs; B also covers the release scripts
and the baseline file, at the cost of a review on every CI change.
