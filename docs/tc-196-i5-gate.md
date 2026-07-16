# TC-196 I5 conformance gate

I5 adds the authored Commander coverage ledger, deterministic registration
scanner, direct/Commander/MCP canonical-envelope fixtures, 13 hermetic local-
key proving scenarios, generated reference blocks, source-boundary checks, and
Node 20 packed-consumer verification.

The proving slice reports one migrated Commander registration (`secrets get`)
and one partial (`auth import`). The partial path is limited to the
request-bound active-session v1 import; legacy delegation, permission, bare
portable, stored-wrapper, and inactive cross-user inputs remain Commander
owned.

The publication state remains `unpublishable-defer` from I0 because MCP SDK v2
is beta. I5 adds honest prerelease changesets and pack verification only; it
does not publish or claim publication readiness.
