---
"@tinycloud/sdk-services": patch
---

Fix the hooks stream supervisor so a failed stream recovers instead of producing an unhandled rejection and crashing Node. Recoverable failures use bounded exponential backoff, including a fresh ticket mint after a stream-open 401/403. Terminal mint refusals reach subscribers as typed service errors. Signing out or ending the session completes active iterators. Stream telemetry is built from an allow-list and does not copy foreign error messages, causes, stacks, or metadata. Retry backoff resets only after an event is received or the stream stays open for at least five seconds. The supervisor yields through a referenced zero-delay timer after each pause so due timers are not starved by repeated immediate retries.
