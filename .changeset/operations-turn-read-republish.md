---
"@tinycloud/operations": patch
---

The profile turn lock no longer fails with `Turn N of the turn lock ... is unreadable` when a turn number is published again while another process reads it. A paused process may publish a removed turn number again; a reader that found no owner record and then found the directory present now reads the record again instead of calling the turn damaged. A directory that is still present without an owner record on the second read is damaged, as before.

Details: TC-3208
