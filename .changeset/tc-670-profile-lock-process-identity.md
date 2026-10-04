---
"@tinycloud/operations": patch
---

Recover a profile turn and `.lock` owned by a prior process incarnation that reused the same PID. Owner records now include a process-wide instance ID and Linux provenance; legacy records retain their PID-only behavior. Cross-namespace recovery requires the same Docker-default container hostname, kernel boot and a different process start, so a live container with a different hostname remains protected. This requires Docker's unpinned, unique hostname; two live PID namespaces deliberately sharing a 12-hex hostname remain unsupported. A recreated container, a host reboot and unavailable provenance continue to wait rather than guessing that an owner is dead.
