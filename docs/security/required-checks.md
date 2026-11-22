# Pre-release security checks: required checks and environment spec

Spec for the repository admin (Amos). Nothing here changes settings by itself;
the workflows only add checks and `environment:` lines. Read-only state below
was taken with `gh api` on 2026-11-22.

## Checks this adds

| Check (context) | Workflow | Runs on | What fails it |
|---|---|---|---|
| `gitleaks` | `.github/workflows/secret-scan.yml` | every PR (PR commits only), every push to master (whole history against `.gitleaksignore`) | a secret-shaped value not in the reviewed baseline |
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
  branch is refused by the branch policy before any step runs. Behaviour
  change: `raw-publish.yml` last ran from `fix/cli-1.7.0-release-base`
  (2026-11-19). That is no longer possible; a branch release goes through
  master, or needs an explicit, temporary branch-policy exception from Bobbie.
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
  166801705 removed; old npm token revoked.
- js-sdk loses access to the organization secrets `NPM_TOKEN`,
  `NPM_CONFIG_TOKEN` and `DISPATCH_TOKEN`. `NPM_TOKEN` is visibility `all`, so
  narrowing it means switching it to `selected` with every other repository
  that needs it, which re-enters its value: an org-wide change for Bobbie to
  approve, best done with the npm token rotation.

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
   Revoke the old npm token and the old `GH_TOKEN` at their issuers. Narrow the
   organization secrets (previous section) with Bobbie's approval. Then add the
   required checks (ruleset section above).

### Undo

- After step 2 only: `gh secret delete <NAME> --env production -R "$R"` for
  each secret added, and `gh repo deploy-key delete <new id> -R "$R"`. Master is
  unchanged.
- After step 3: revert the `environment: production` commit; the jobs read the
  repository and organization secrets again (still present until step 4).
- After step 4: revert the `environment: production` commit, recreate the
  repository secrets (`gh secret set <NAME> -R "$R"`): `GH_TOKEN` with the step 2
  token, `RELEASE_DEPLOY_KEY` with a fresh deploy key pair made as in step 2
  (its private half was not kept), and add js-sdk back to the organization
  secrets' repository access. The revoked old values are not restored. The
  environment secrets can stay; only jobs that name the environment read them.
