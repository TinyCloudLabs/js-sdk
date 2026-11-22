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

### Before

- Environment `production`: deployment branch policy = branch `master` only, no
  reviewers. Secrets: `BETTERSTACK_SOURCE_TOKEN`, `CLOUDFLARE_API_TOKEN`,
  `PHALA_CLOUD_API_KEY`, `TC_MCP_INTROSPECTION_CLIENT_ID`,
  `TC_MCP_INTROSPECTION_CLIENT_SECRET`, `TC_MCP_NATIVE_SERVICE_CREDENTIAL`,
  `TC_MCP_STATE_SECRET`. Used by `mcp-image.yml` (`preflight`, `deploy`).
- Repository secrets (readable by a workflow on any branch): `GH_TOKEN`,
  `RELEASE_DEPLOY_KEY`, `TC_MCP_INTROSPECTION_CLIENT_ID`,
  `TC_MCP_INTROSPECTION_CLIENT_SECRET`.
- Organization secrets this repository can read: `NPM_TOKEN` (visibility
  `all`), `NPM_CONFIG_TOKEN`, `DISPATCH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  (visibility `selected`, js-sdk included).
- Jobs that read publish credentials, none with an environment:

  | Workflow / job | Secrets |
  |---|---|
  | `changesets.yml` `beta`, `stable` | `NPM_TOKEN`, `RELEASE_DEPLOY_KEY` |
  | `changesets.yml` `beta-resume` | `NPM_TOKEN` |
  | `raw-publish.yml` `publish` | `NPM_TOKEN` |
  | `npm-latest-rollback.yml` `rollback` | `NPM_TOKEN` |
  | `manual-release.yml` `release` | `NPM_TOKEN`, `GH_TOKEN` |

### After

**Where #1130 expects `NPM_TOKEN`: an environment secret named `NPM_TOKEN`
in the `production` environment of TinyCloudLabs/js-sdk.** Not a repository
secret and not an organization secret. The workflows keep reading
`secrets.NPM_TOKEN`; with `environment: production` on the job, GitHub
resolves the environment secret first. The same holds for `RELEASE_DEPLOY_KEY`
and `GH_TOKEN`.

- The six jobs above declare `environment: production` (the last commit of
  this PR). They then run only from `master`; a dispatch from another branch is
  refused by the environment's branch policy before any step runs.
- Environment `production` (exists today: branch policy `master` only, no
  required reviewers; keep it that way) additionally holds these environment
  secrets:
  - `NPM_TOKEN`: the new npm granular token, publish rights on the
    `@tinycloud` scope only;
  - `RELEASE_DEPLOY_KEY`: a new deploy key pair, the public half added as a
    write deploy key, the private half here;
  - `GH_TOKEN`: a new token, only if `manual-release.yml` is kept.
- Repository secrets `GH_TOKEN`, `RELEASE_DEPLOY_KEY`,
  `TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET`
  deleted (the last two already exist in `production`, which is the only place
  they are used: `mcp-image.yml` `deploy`). The old deploy key is removed from
  the repository's deploy keys, and the old npm token revoked.
- js-sdk removed from the repository access of the organization secrets
  `NPM_TOKEN`, `NPM_CONFIG_TOKEN` and `DISPATCH_TOKEN` (no js-sdk workflow
  reads the last two). `NPM_TOKEN` is visibility `all`, so this means switching
  it to `selected` with every other repository that needs it: an org-wide
  change for Bobbie to approve.

### Order (Naomi, 2026-11-22 10:12Z)

The publish path (tarball audit, environment) and the npm credential must not
change at once, so this PR stays open until step 2.

1. With master as it is today, the new `NPM_TOKEN` is used for the first
   successful beta publish (`@tinycloud/cli` 1.9.0-beta.0 / SDK
   3.14.0-beta.1). On today's master the jobs have no environment, so that run
   reads the repository or organization `NPM_TOKEN`.
2. Amos confirms the `production` environment (master only, no reviewers) and
   adds the environment secrets above, with `NPM_TOKEN` holding the same new
   token as step 1.
3. Merge this PR. The next beta run publishes with the `production`
   environment's `NPM_TOKEN` and `RELEASE_DEPLOY_KEY`, after the tarball audit.
4. After that run is green: delete the repository secrets and the old deploy
   key, revoke the old npm token, and narrow the organization secrets'
   repository access. Then add the required checks (ruleset section above).

### Undo

- Revert the `environment: production` commit (the jobs then read repository
  and organization secrets again).
- Recreate the repository secrets `RELEASE_DEPLOY_KEY` and `GH_TOKEN` with the
  values from step 2 (the old values were rotated, so they are not restored),
  and add js-sdk back to the organization secrets' repository access.
- The environment secrets can stay; they are only read by jobs that name the
  environment.
