---
"@tinycloud/cli": patch
---

Exit-code change for scripts: `tinycloud share` now exits 2 (invalid input) instead of 8 for `UNSAFE_FILENAME`, `UNSAFE_PATH` and `OUTPUT_EXISTS`. These refusals cannot change when the same command is retried, and exit 8 stays reserved for pending states (a pending owner approval, `secrets wait`). Scripts that treated 8 from `share` as "retry later" should now treat these three codes as input errors. Nothing is written to stdout for them; the error JSON goes to stderr.

Details: TC-2609
