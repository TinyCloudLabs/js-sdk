---
"@tinycloud/bootstrap": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

A third-party app can sign in for an owner whose account is hosted on the default node (`https://node.tinycloud.xyz`) but has no registry record, instead of failing with `ACCOUNT_SETUP_REQUIRED`. This applies only when the app asks for nothing beyond its own `applications` space and holds an uncaveated `tinycloud.kv/list` or `tinycloud.space/info` on it, with no space host, create or delete ability. After the owner's consent the SDK sends one `/delegate` to the default node and one read of that space (`kv/list` with limit 1, or `space/info`). A 2xx proves the space is hosted and sign-in continues. Any other answer returns `ACCOUNT_SETUP_REQUIRED`, clears the saved session and discards it locally without a `/session/retire` or a second `/delegate`; a network error, timeout or 5xx during the check fails with a non-setup error and the same local discard. No account, space, key or registry record is ever created or written for this path. The same read runs once when a restored session of such an owner first needs a route. Configured hosts are never used. Registered, first-party and unavailable-registry sign-ins are unchanged.

Breaking for TinyChat's native webview origins: `https://app.tinycloud.one` and `tinycloudone://app.tinycloud.one` are no longer first-party origins, so they get the third-party sign-in policy. `https://feed.tinycloud.xyz` is now a first-party origin.

Details: TC-4082
