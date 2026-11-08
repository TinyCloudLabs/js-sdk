---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/sdk-core": patch
---

Use storage-server and storage-settings vocabulary in owner-facing routing errors and offline inspection help. Keep existing error codes, retryability, command behavior, account-identifier parsing and JSON schemas. Display the optional inspection argument as `account-id` and label the human output with account, version, age and decryption service.

Human inspection displays the saved age in seconds below one minute, minutes through two hours, and hours above two hours. Storage modes read “read and write” or “read only”; server and decryption IDs are labelled while retaining their verified values. Partial permission registration uses the same server vocabulary without changing its code or retry verdict. Developer-facing SDK diagnostic templates are unchanged.

Use Monica's final warning copy for the existing cold fallback and verified saved-copy paths. Describe the server the CLI normally picks without guessing whether it came from a flag, environment, discovery, profile or default; describe the saved copy as checked within the last hour without inventing an exact age. Warning codes and machine-readable reasons are unchanged.

The separate cold-device refusal change remains a required dependency before stable release; wording does not itself change routing behavior.

Details: TC-2481
