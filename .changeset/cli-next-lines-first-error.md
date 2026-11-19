---
"@tinycloud/cli": patch
---

`Next:` lines now appear only where there is one definite next step, and the first error on a computer that isn't signed in says why.

- After `onboard` completes, a `Next:` line on stderr offers `skill save`, in the invocation form that works on this computer. It is left out when the guide is already saved and current, when a skills folder holds files TinyCloud didn't write, and when no agent's skills folder is found.
- After `skill save` succeeds, a `Next:` line on stderr sends the agent back to the owner's request.
- The error for a computer with no sign-in (`AUTH_REQUIRED`) now reads "This computer isn't signed in.", and a `Next:` line offers `onboard`, instead of "Not authenticated. Run `tc auth login` or `tc init` first." Anything that matches on the old message text needs updating.

Details: TC-3278
