---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

User-facing text in the CLI and SDK names the product TinyCloud One. `AccountSetupRequiredError` sends people to https://tinycloud.one/ to finish setting up their account. The CLI README's feed section is titled "TinyCloud One feed" (anchor `#tinycloud-one-feed`), and `tinycloud feed --help` and the CLI auth skill say TinyCloud One.

Upgrading: `AccountSetupRequiredError.setupUrl` is "https://tinycloud.one/". Code that compared it with "https://home.tinycloud.xyz/" needs the new value.

Details: TC-3659
