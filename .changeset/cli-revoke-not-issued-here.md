---
"@tinycloud/cli": patch
---

`tc delegation revoke` refuses a delegation that another account issued, with exit code 5 and a message telling the user to ask whoever issued it. Before the refusal the CLI signs only the read-only delegation list query with the existing session key; it makes no revoke signature, authority request or permission prompt.

Details: TC-2132
