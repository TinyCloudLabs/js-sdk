---
"@tinycloud/cli": patch
---

The skills folder for each agent client now comes from one data file, `clients.json`, and a test pins the file's hash so a change to it is deliberate. `skill save` and the list of clients in its error are built from that file; their behavior does not change.

Details: TC-3278
