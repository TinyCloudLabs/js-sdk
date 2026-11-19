---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
"@tinycloud/replica": minor
---

Interactive SDK requests now take priority over background replica traffic. Replica requests run one at a time per host and wait for a 400 ms quiet window after foreground activity. A background request waits at most 5 s for foreground traffic, but always honours a node-busy pause. Foreground node-busy retries are bounded.

New options: `ServiceContextConfig.priority`, `RetryPolicy.foregroundBusyMaxTotalMs` and `DelegateToOptions.priority`. New exports: `backgroundFetch`, `inheritResourceRouting` and `withDeadline`, plus the `./request-priority` and `./internal/response-body` subpaths.

Request timeouts start when a request is sent, not while it waits for its turn. Hook event streams do not hold a priority slot, and an unread response releases its slot after 15 s. Writes routed to several nodes finish each reply before contacting the next node, so two writes can't block each other.

Pending operations are cancelled when the session changes. KV, SQL migrations, Secrets pages and named-key operations stay bound to the session they started with. Cancelling a decrypt now reports a transport error instead of "Local decryption failed". KV calls can be cancelled while the local replica is still loading, and their timeout starts after it loads.

Details: TC-2771
