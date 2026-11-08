---
"@tinycloud/cli": patch
---

`tinycloud auth login --device` no longer refuses a manifest that asks for decrypt on your own `default` network (`tinycloud.encryption/decrypt`, space `default`, empty path). The CLI sends that entry to OpenKey as written. When the owner approves it, OpenKey signs decrypt on the approving owner's own `default` network, and the CLI checks that signature against the verified owner and saves it with the session. An approval signed for anything broader (encrypt as well, another network, another owner's network, a path nested under the network, or decrypt inside the space) is refused and nothing is saved. Every other encryption entry and the `secrets` space are still refused before OpenKey is asked, with `DEVICE_AUTH_UNSUPPORTED_SCOPE`, whose message now reads "--device can't authorize the secrets space, or tinycloud.encryption beyond decrypt on the default network."

Details: TC-2534
