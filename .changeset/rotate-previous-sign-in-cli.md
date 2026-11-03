---
"@tinycloud/cli": patch
---

`tc auth rotate` now says that the previous sign-in stays live until its expiry, and where to revoke it. This CLI cannot revoke the OpenKey login delegation a rotation replaces, so after a rotation that succeeded and replaced a live session it prints one line on stderr: `The previous sign-in (<CID>) stays live until <expiry> because this CLI cannot revoke it; revoke it at https://account.tinycloud.xyz/delegations.` The CID part is left out when the old session does not hold one, and `until it expires` stands in for an unknown date. Nothing is printed on a first login, when there was no previous session, when it had already ended, or when the rotation was refused or failed. stdout, the JSON output and exit codes are unchanged.

Details: TC-2412
