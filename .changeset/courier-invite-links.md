---
"@tinycloud/courier": minor
---

Invites are links of the `courier` type of the links API, through `@tinycloud/share-envelope/links`. `invite` prints `https://<COURIER_LINK_ORIGIN>/c/<id>#v=4&k=<key>&c=<content id>`; `join` takes that link.

- `COURIER_LINK_ORIGIN` (the https origin of the share viewer in the link) has no default: `invite` and `join` stop with `link-origin-unset` until it is set. `COURIER_LINKS_API_ORIGIN` names the links API and defaults to `https://api.tinycloud.xyz`.
- `--ttl` is checked before any request: at least 2 minutes, at most 7 days, 24 hours by default, as the `courier` link type allows. An invitation over the 65,536-byte link limit is refused before it is signed (`invite-too-large`).
- Each invite is signed with its own throwaway Ed25519 key. Its seed is kept in the private invite record (mode 0600) and used only to sign the delete; `invite revoke` and the watcher delete the link with it, and a failed delete is logged without the key. The old invite-store client and `COURIER_INVITE_ORIGIN` are removed.
- The invitation names its signing key as `issuer`; `join` refuses one whose `issuer` is not the key that signed the link (`invite-issuer-mismatch`) before it reads any other field.
- The invitation and the public invite record carry a hash of the invited address (domain-separated SHA-256, salted with the invite id), not the address; the public record field is `expectEmailHash`. `join --email <address>` is checked against it, and is required with `--credential-file` or `--credential-stdin`.
- `join` prints the inviter the link names (owner DID, handle, space) and proceeds only with `--expect-inviter <owner-did>` equal to that owner; otherwise it sends nothing and prints the facts and the command to run (`inviter-unconfirmed`, `inviter-mismatch`).
- Failures of the links service map to stable codes (`invite-gone`, `invite-rate-limited`, `invite-unavailable`, `invite-unreachable`, `invite-store-error`, `invite-origin`, `invite-clock`, `bad-invite`) with fixed messages; nothing the service says is shown.

Details: TC-712
