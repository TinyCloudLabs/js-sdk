---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/sdk-core": patch
---

Use storage-server and storage-settings vocabulary in owner-facing routing errors and offline inspection help. Keep existing error codes, retryability, command behavior, account-identifier parsing and JSON schemas. Display the optional inspection argument as `account-id` and label the human output with account, version, age and decryption service.

Human inspection displays the saved age in seconds below one minute, minutes through two hours, and hours above two hours. Storage modes read “read and write” or “read only”; server and decryption IDs are labelled while retaining their verified values. Partial permission registration uses the same server vocabulary without changing its code or retry verdict. Developer-facing SDK diagnostic templates are unchanged.

Use Monica's final warning for verified saved-copy routing without inventing an exact age. Remove the unreachable cold-fallback formatter now that #873 refuses cold routing; retain the approved refusal, warning code and machine-readable saved-copy reason.

This presentation-only change is stacked on #873's required cold-device refusal, which must land before stable release; it does not add a fallback or change routing authority.

Details: TC-2481
