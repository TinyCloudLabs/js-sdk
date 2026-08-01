---
"@tinycloud/web-sdk": patch
---

Replace the web SDK's runtime ethers, SIWE, lodash.merge, and MetaMask provider
dependencies with the already-present viem implementation. `TinyCloudWeb.provider`
keeps its legacy Web3-provider facade for existing callers; the normalized
EIP-1193 provider is also available as the explicitly named
`TinyCloudWeb.eip1193Provider` member.
