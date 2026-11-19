---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": patch
---

`tc onboard` asks for the whole task in one OpenKey approval (step 1 of 1) instead of one approval per space. `--with apps` (the default), `--with feed` (discovery plus the named Home/feed SQL read/write/schema and feed hooks subscribe, without the generic apps grant) or `--with apps,feed` choose the task. A multi-space approval that omits a requested space is refused with that space named, and nothing is saved. Onboarding, Share publishing, `tc secrets` and delegation revocation send OpenKey a short human context line; OpenKey shows the requested permissions separately. Device authorization stays limited to one space.

`@tinycloud/node-sdk` accepts a signed session grant that spans several of its owner's spaces, keeps each resource's own space in portable grants, and routes a manifest sign-in through `applications` when requested, otherwise the first requested space.

Needs OpenKey with multi-space approvals (`requestedSpaces` in the delegation response, OpenKey PR #430).

Details: TC-2490
