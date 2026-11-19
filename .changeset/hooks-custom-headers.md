---
"@tinycloud/cli": minor
"@tinycloud/sdk-services": minor
---

Webhooks can carry custom headers, so a receiver that needs its own credential (for example a Grok Bot routine's `Authorization: Bearer`) can be woken by an owner's answer or comment. `HooksService.register` takes `headers` and refuses reserved ones (Host, Content-Length, Content-Type, Cookie, `X-TinyCloud-*` and other transport headers) and line breaks before any request; `HookWebhookRecord.headerNames` lists names only, since values are write-only. `HookEvent` gains `tableName` and the node's `rowId` (a SQL insert's row id; for `feed_responses` its `sequence`), and `drainFeedResponses` hands off pending feed responses once without a stream.

CLI: new `tinycloud hooks register|list|remove`; `feed connect --notify-url` with `--notify-header`, `--notify-header-env`, `--notify-header-file` and `--notify-header-stdin` registers a webhook on the agent's response database (registering the new one before removing an earlier one for the same URL, so receivers dedupe on `X-TinyCloud-Event-Id`; at the node's webhook cap it removes first and says to run `feed watch --drain` once; it withdraws the webhook if the node does not confirm the header names); `feed watch --drain` delivers every pending answer and owner message, with card and response IDs, once and exits. Header values are never echoed, logged or saved.

Details: TC-3123
