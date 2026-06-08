---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": patch
---

Add CLI auth artifact handoff flows for owner/delegate workflows.

`tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
default, with `--grant` preserving the immediate grant behavior. Profiles now
track canonical posture/operator metadata so a local key, OpenKey owner, or
delegate session can be represented explicitly.

New commands:

- `tc auth grant <request>` consumes a request artifact as an owner profile and
  emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
  grants can use `--yes` for non-interactive approval.
- `tc auth import <artifact>` installs delegation artifacts and preserves their
  originating request id.
- `tc auth retry <requestId|--last> --exec` reruns the captured command once the
  requested permissions are covered.

Local-key CLI profiles now persist and restore their TinyCloud session key
identity so request artifacts target the same session key that later imports the
delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
fragmentless form of the current session DID (`did:key:...`) as equivalent to
the session verification method DID URL (`did:key:...#...`).
