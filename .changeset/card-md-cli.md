---
"@tinycloud/cli": minor
"@tinycloud/sdk-services": minor
---

`feed card-md` prints the owner's card.md (`{text, version, updatedAt}`, or `null` when none is set). `feed publish` adds `cardMd: {version}` to its JSON, and `feed publish` and `feed watch` print the text once on stderr when its version differs from the last one seen for that profile and agent token. An agent connected before card.md existed reads it with the same grant, without reconnecting. `@tinycloud/sdk-services` adds `readFeedCardMd` and an optional `onWake` callback on `listenFeedResponses`, run at the start of every drain.

Details: TC-3345
