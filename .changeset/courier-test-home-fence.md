---
"@tinycloud/courier": patch
---

The courier test suite now runs every test file under a temporary home, and with `COURIER_TEST=1` the profile directory resolver refuses a home outside `COURIER_TEST_HOME` (`test-home-escape`). Without `COURIER_TEST=1` behaviour is unchanged.

Details: TC-712
