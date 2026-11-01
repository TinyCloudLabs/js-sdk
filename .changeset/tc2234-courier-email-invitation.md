---
"@tinycloud/courier": minor
"@tinycloud/node-sdk": minor
"@tinycloud/cli": patch
---

Courier can send and open an email-bound invitation through the existing Share path (`courier invite --mode email --recipient <email>`, `courier join <share link> --consent [--code-stdin]`). The invitation body, with its existing pairing relay, is encrypted under a fresh `share/<shareId>` key and registered as one path-bound, digested Share policy owned by the Courier `did:key`; OpenCredentials mails the link and only the verified mailbox holder can open it. One invitation opens exactly one conversation; the session join, read and peer-delegation path is the existing one. The mode is not listed in `INVITATION_MODES` or the guide.

Courier's grant check stays exact for existing installs. It additionally accepts, only when the owner is known, `key.create` and `decrypt` on `<owner default network>/share/` (or one exact `share/<32 hex>` key) and nothing else. Courier does not request that authority: `AGENT_GRANT` and the OpenKey request are unchanged, and a grant without it cannot send email invitations (`invite-authority-missing`, nothing created). Which scope to request, and the OpenKey `/delegate` change that issues it, are open decisions.

`@tinycloud/node-sdk` adds `@tinycloud/node-sdk/share-publish` (`publishEmailShareV3`, moved unchanged from the CLI), `emailProofDescriptor` in `@tinycloud/node-sdk/credentials`, and `resumeAgentShareReceive` in `@tinycloud/node-sdk/share-receive` for a two-step receive across processes. The CLI imports `publishEmailShareV3` from node-sdk.

Needs a node release containing the Policy/v3 named-key binding (#481) and the refusal of unbound registrations (#485) before it works against production.

Details: TC-2234
