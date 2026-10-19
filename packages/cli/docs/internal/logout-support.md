# Support: a pending logout that belongs to another principal

Internal note for support. Not published with the package.

## Symptom

Every command on the profile refuses with `REPLICA_GATED`:

> The pending logout on profile "<name>" belongs to a different principal than
> the current session; credentials, replica files and the logout marker were
> left unchanged, and local replica reads stay blocked. Contact support to
> finish it.

The profile holds `replica-logout-pending.json` from one account's interrupted
`tc auth logout`, while `session.json` belongs to a different account. The CLI
never lets one account's session finish another account's logout, because
recovery would delete that session's credentials.

## Exit: move `session.json` aside

1. Move `<profile>/session.json` to another name, for example
   `session.json.aside`.
2. Run any command on the profile, for example `tc --profile <name> auth status`.
   With no session to attribute, startup recovery finishes the pending logout:
   it denies the replica gate, marks the profile signed out, removes `key.json`,
   erases the local replicas and clears the marker. The command then reports the
   profile as signed out.
3. Delete the moved-aside file. It still contains that session's private key.
4. Sign in again with `tc auth login`.

Verified against the CLI on 2026-10-17: before the move, `auth status` exits 1
with the refusal above. After the move it exits 0. The marker, `key.json` and the
replica roots are gone, the gate is denied, and the moved-aside file is
untouched.

## Do not move the logout marker instead

Moving `replica-logout-pending.json` aside is unsafe (earlier probe, same
scenario):

- For an orphan or inactive gate (v2/v3 marker), the next logout treats
  everything as its own and erases it, including the current account's session.
- For an active gate (v1 marker), the profile stays stuck: the gate still
  refuses the other account and the original logout can no longer complete.

## Other refusals

- "a previous sign-out was interrupted; re-running `tc auth logout` completes
  it": run `tc auth logout` again on that profile.
- "an older gate may have been restored": the gate no longer matches the
  logout's recorded sign-out and cannot be repaired in place. Switch the default
  profile if needed (`tc profile switch <other>`), then run
  `tc profile delete <name>` and sign in again.
