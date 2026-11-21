---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": minor
---

`tinycloud onboard` asks for the whole task in one OpenKey approval. `--with apps` (the default), `--with feed` (the Feed only, without the general apps grant) or `--with apps,feed` chooses the task. `onboard --json` still lists `granted` as `{ space, asks }`, now in sorted space order (`account` before `applications`), and each entry carries the approval's text. If the owner approves fewer spaces than requested, the CLI names the missing space and saves nothing. Onboarding, Share publishing, `tinycloud secrets` and revoking access now send OpenKey a short line saying what the request is for; OpenKey still lists the permissions separately. Device sign-in stays limited to one space.

`@tinycloud/node-sdk` accepts a signed session grant that spans several of its owner's spaces and keeps each resource's own space in portable grants. A manifest sign-in now picks its primary space among the manifest's own requested spaces: `applications` when requested, otherwise the first in sorted space-id order (previously the first non-`account` space in request order).

Details: TC-2490
