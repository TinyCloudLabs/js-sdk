---
"@tinycloud/web-sdk": major
---

TC-292 removes the standalone chain/RPC layer and signs through the connected
wallet's raw EIP-1193 provider. `TinyCloudWeb.provider` is now the raw
EIP-1193 provider rather than an ethers-compatible Web3 provider facade; the
standalone RPC provider factory and its network URL fallback are removed.
ENS resolution remains available through the connected wallet provider.
