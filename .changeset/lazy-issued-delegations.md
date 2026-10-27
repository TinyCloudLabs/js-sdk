---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

The issued-delegation code (the `direction: "issued"` query and its paging, `queryAllIssued`, `revokeIssued`, the 401/403/400/503 mapping) is its own module, exported as `@tinycloud/sdk-core/delegations/issued`. `DelegationManager.query({ direction: "issued" })`, `queryAllIssued` and `revokeIssued` keep their signatures and results and load that module with a dynamic `import()` on first use. `@tinycloud/web-sdk` builds it as the lazy chunk `delegations-issued.mjs` / `delegations-issued.cjs` next to `index.*` and `credentials.*`, so those bundles carry only the loader.

Details: TC-2132
