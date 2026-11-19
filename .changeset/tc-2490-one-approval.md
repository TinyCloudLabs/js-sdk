---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": minor
---

`tinycloud onboard` asks for the whole task in one OpenKey approval (step 1 of 1) instead of one approval per space. `--with apps` (the default), `--with feed` (discovery plus the named Home/feed SQL read/write/schema and feed hooks subscribe, without the generic apps grant) or `--with apps,feed` choose the task. `onboard --json` still lists `granted` as `{ space, asks }`, now in sorted space order (`account` before `applications`), and every entry carries the one approval's text. A multi-space approval that omits a requested space is refused with that space named, and nothing is saved. Onboarding, Share publishing, `tinycloud secrets` and delegation revocation send OpenKey a short human context line; OpenKey shows the requested permissions separately. Device authorization stays limited to one space.

`@tinycloud/node-sdk` accepts a signed session grant that spans several of its owner's spaces and keeps each resource's own space in portable grants. A manifest sign-in now picks its primary space among the manifest's own requested spaces: `applications` when requested, otherwise the first in sorted space-id order (previously the first non-`account` space in request order).

Needs OpenKey with multi-space approvals (`requestedSpaces` in the delegation response, OpenKey PR #430): release only after it is deployed.

Details: TC-2490
