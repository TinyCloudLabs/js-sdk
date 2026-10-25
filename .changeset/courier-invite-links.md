---
"@tinycloud/courier": minor
---

Invites are links of the `courier` type of the links API, through `@tinycloud/share-envelope/links`. `invite` prints `https://<viewer origin>/c/<id>#v=4&k=<key>&c=<content id>`; `join` takes that link.

- The viewer origin in the link is the production viewer (`https://share.tinycloud.xyz`, the SDK's `DEFAULT_SHARE_ORIGINS[0]`); `COURIER_LINK_ORIGIN` overrides it and must be a canonical https origin. `COURIER_LINKS_API_ORIGIN` names the links API and defaults to `https://api.tinycloud.xyz`. The links API origin is kept in the private invite record and `invite revoke` and the watcher delete against it; a record without one uses the default.
- `--ttl` is checked before any request: at least 2 minutes, at most 7 days, 24 hours by default, as the `courier` link type allows. An invitation over the 65,536-byte link limit is refused before it is signed (`invite-too-large`).
- Each invite is signed with its own throwaway Ed25519 key. Its seed is kept in the private invite record (mode 0600) and used only to sign the delete; `invite revoke` and the watcher delete the link with it, and a failed delete is logged without the key. The old invite-store client and `COURIER_INVITE_ORIGIN` are removed.
- The invitation names its signing key as `issuer`; `join` refuses one whose `issuer` is not the key that signed the link (`invite-issuer-mismatch`) before it reads any other field; Courier repeats the check on the parsed invitation.
- The invitation and the public invite record carry a hash of the invited address (domain-separated SHA-256, salted with the invite id), not the address; the public record field is `expectEmailHash`. `join --email <address>` is checked against it, and is required with `--credential-file` or `--credential-stdin`.
- `join` prints the inviter the link names (owner DID, handle, space) and proceeds only with `--expect-inviter <owner-did>` equal to that owner and only when the invitation's read and put delegations verify as that owner's (issuer, audience, space, and host activation); otherwise it sends nothing and creates nothing (`inviter-unconfirmed`, `inviter-mismatch`, `inviter-unproven`, `inviter-unchecked` when the host is unavailable). The refusal prints the facts and a command with a `<did you expect>` placeholder.
- Failures of the links service map to stable codes (`invite-gone`, `invite-rate-limited`, `invite-unavailable`, `invite-unreachable`, `invite-store-error`, `invite-origin`, `invite-clock`, `bad-invite`) with fixed messages; nothing the service says is shown.

Details: TC-712
