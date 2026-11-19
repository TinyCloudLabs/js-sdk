---
"@tinycloud/cli": patch
"@tinycloud/sdk-services": minor
---

`tinycloud feed show` keeps the owner's answer, acknowledgement and outcome across a reply-only revision, as Home does: when the agent publishes a revision that only appends `payload.replies` (a post's first reply may also turn `render` into `thread`), the card is reported at its newest revision with the earlier answer, and the new `answeredAtRevision` says which revision was answered. Before, the CLI showed no answer after the agent replied to an owner's comment.

sdk-services: `getFeedCardState` takes an optional `{ carryReplyOnlyAnswer }` (default false, so every existing caller, Home included, is unchanged), `FeedCardState` gains `answeredAtRevision`, and `isReplyOnlyRevision(previous, next)` is exported (the same rule as Home's, for one agent's cards).

Details: TC-3152
