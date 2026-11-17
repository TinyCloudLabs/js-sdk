---
"@tinycloud/courier": minor
"@tinycloud/node-sdk": minor
"@tinycloud/cli": patch
---

Adds the Courier email-invitation code on the existing Share path (`courier invite --mode email --recipient <email>`, `courier join <share link> --consent [--code-stdin]`). **It cannot send a real invitation yet.** The mode is hidden (it isn't listed in `INVITATION_MODES`, the usage text or the guide). It asks OpenKey for a per-invitation approval (see the invite-approval entry), which OpenKey does not handle yet, and it creates nothing until that approval arrives. The design: the invitation body, with its existing pairing relay, is encrypted under a fresh `share/<shareId>` key and registered as one path-bound, digested Share policy owned by the Courier `did:key`; OpenCredentials mails the link, and only the verified mailbox holder can open it; the session join, read and peer-delegation path is the existing one. The send and receive steps are tested only against stand-ins: no full link, decrypt and join run exists.

Courier's grant check is exact: the base grant is exactly `AGENT_GRANT`, and any `share/` entry (one exact key, the prefix, several keys, half a pair) is refused at grant load as `grant-too-broad`. The standing base grant never carries a share key. While the owner's approval is pending, `courier invite --mode email` stops with `invite-approval-pending`; if the approval can't be requested or is refused, it stops with `invite-authority-missing`. Either way it creates no pairing relay delegation, invitation state, Share key, link or email. Calling the library `sendEmailInvitation` after `issueInvitation` and failing the same check leaves the relay delegation (it expires with the invitation) and the invitation state record, which nothing deletes; the error message names both.

Opening an invitation (`courier join <link> --consent --code-stdin`) checks everything it can before the one-time code reaches the witness: the signed envelope's exact resource path (`…/to/invite-<id>/envelope/<shareId>.json`), its expiry, its node origin against this profile's host, that its issuer is not this agent, the local profile, grant and node, and whether this invitation id was already joined. A failed check leaves the pending proof untouched. The body is encrypted, so its session, relay and pairing artifact cannot be checked until it is decrypted; then its id, node origin, issuer, expiry and space must equal the envelope's and the join state is checked again. The pending proof follows `courier credential acquire`: it is kept after a recoverable witness rejection (`EmailProofError.recoverable`) so the same request takes another code, and deleted on a terminal failure, once the code was accepted, and on success.

`@tinycloud/node-sdk` adds `@tinycloud/node-sdk/share-publish` (`publishEmailShareV3`, moved unchanged from the CLI), `emailProofDescriptor` in `@tinycloud/node-sdk/credentials`, and `resumeAgentShareReceive` in `@tinycloud/node-sdk/share-receive` for a two-step receive across processes. The CLI imports `publishEmailShareV3` from node-sdk.

The node side (the Policy/v3 named-key binding, #481, and the refusal of unbound registrations, #485) is in production node 1.26.8.

Details: TC-2234
