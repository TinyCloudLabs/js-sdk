---
"@tinycloud/courier": patch
---

`courier watch --home-file` now accepts only the known model-login file of a supported agent CLI, instead of refusing a short denylist: `.codex/auth.json` (codex), `.gemini/oauth_creds.json` (gemini), `.local/share/opencode/auth.json` (opencode), `.local/share/amp/secrets.json` (amp), `.config/goose/secrets.yaml` (goose) and `.aider/oauth-keys.env` (aider). `omp` and `cursor-agent` accept no file (omp keeps its login in a database with every account; Cursor does not publish where its credentials are): pass their login with `--env-pass` or run them under their own account. When `--exec` starts one of these CLIs only that CLI's file is accepted; for any other command any listed file is. Settings files, owner state (`.omp`, `.tinycloud`, `.gnupg`, `.docker`, `.kube`, `.config/gcloud`, `.paseo`) and every other file are refused with a clear message, when the watcher starts and again on every wake. `--wake claude` takes no `--home-file`.

A `--home-file` source that is a symbolic link, or that sits behind one (a linked `.codex` directory, for example), is refused and its target is never copied; the check runs on every wake and the file is opened without following links.

The README now warns plainly that `--unguarded --agent-cli` puts outside message content into an agent that can act, and that it should only be used with an agent holding no credentials beyond its model login, in a sandbox.

Details: TC-3014
