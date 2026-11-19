---
"@tinycloud/cli": patch
---

Skill docs: REFERENCE.md and AUTH.md are split into files under 25 KB so agents can read them with one command; the pack check now fails if a skill file grows past that. `REFERENCE.md` and `AUTH.md` stay as the entry points, and every heading that moved keeps a one-line `Moved: see ...` pointer, so old links such as `REFERENCE.md#local-replicas` still land on a heading. The new parts are `REFERENCE-2.md` (secrets, local replicas, replication diagnostics), `REFERENCE-3.md` (share publish), `REFERENCE-4.md` (artifacts, KV input, profile directory, DIDs) and `AUTH-2.md` (secret reads, imported delegations, stored grants); SKILL.md lists every file. No command behaviour changes.

Details: TC-2436
