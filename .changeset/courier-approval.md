---
"@tinycloud/courier": minor
---

`courier approval <requestId>`: verifies the owner's decision before a gated action. The approval in `me/approvals/` must name the request, carry the SHA-256 of the request's canonical JSON (`canonicalJson` and `requestHash` are exported), say `approved`, be under 24 hours old and inside the request's lifetime, and match your `--verb` and `--target`; it is consumed once (create-only marker under `me/consumed/`). `courier watch` now wakes the thread's agent as soon as a new approval appears; the wake prompt tells the agent to run `courier approval` first.

`courier request` now requires `--verb` (merge, deploy, publish, spend, other), `--target` (canonical per verb) and `--summary` (one line, at most 200 characters); they are stored in the request and covered by its hash, so older free-text-only requests can no longer be approved. `--action` is optional display text.
