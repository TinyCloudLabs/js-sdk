# Personal apps in TinyCloud: quickstart

Background and walkthrough for the `tc-apps` skill. The runnable blocks are in `SKILL.md` and `SQL.md`; the agent runs them from there.

Your agent keeps what you tell it in your own TinyCloud storage, in apps it creates as you go. You might log your weight one day, set a goal the next, start logging lifts, take up a new sport, then add a todo:
- **Apps appear on demand.** Fitness and todos each become an app, without a new install.
- **Apps grow on demand.** A new kind of record, or a new detail, is added when you first mention it, without a migration.
- **Any agent can carry on.** A new conversation in Claude Code, Codex or OpenCode finds every app and how it's stored, without being told.

It works in Claude Code, Codex and OpenCode, and needs Node.js 22.20 or later with npm. The skill runs `@tinycloud/cli@1.3.5` from a folder of its own, and `@tinycloud/cli@1.5.0-beta.2` from a second folder for apps in their own folder (below).

A permission slip and the code OpenKey shows after you approve are fine to share; keys and session files are not. The full list is in [What is and isn't secret](https://agents.tinycloud.xyz/agent#what-is-and-isnt-secret).

## 0. Setup, in the same prompt

Add the setup link to your first request:

> Fetch https://agents.tinycloud.xyz/apps with curl and follow it. Log this meal in my TinyCloud: breakfast, two eggs and a slice of toast, about 350 kcal.

The agent follows the setup at [`agents.tinycloud.xyz/apps`](https://agents.tinycloud.xyz/apps), then carries on with your request in the same conversation:
1. It checks Node.js and npm. If either is missing, or Node.js is older than 22.20, it stops and tells you; it doesn't install them.
2. It installs the CLI into `~/.local/share/tc-apps/cli`, a folder only this skill uses, unless it's already there. A `tc` on your `PATH` stays as it is. Next to it, it writes `~/.local/share/tc-apps/tinycloud`, a short script that runs this CLI and retries when TinyCloud drops a connection.
3. It installs the skill for your user, so every project folder sees it: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/tc-apps/` for Claude Code, `~/.agents/skills/tc-apps/` for Codex and OpenCode.
4. It reads the skill and signs you in, as below.

No shell profile to edit, and nothing to restart except OpenCode, once (see below). Afterwards, any new conversation in any folder can use your apps without the link.

| Client | Start | What to expect |
|---|---|---|
| Claude Code | `claude` | Claude Code can deny a step or the sign-in, or ask you to confirm it. The agent then shows you the step and asks you to reply naming it: [Confirming a step in Claude Code](https://agents.tinycloud.xyz/apps#if-claude-code-still-blocks-it). Manual mode asks on first use for the setup page, the check, the install and each kind of skill step; choose "Yes, and don't ask again" where it's offered. Steps that run commands side by side, or write the skill's state folder, ask every time in manual mode. |
| Codex | `codex -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/.tinycloud --add-dir ~/.local/state/tc-apps` | One approval, for the install. The CLI needs the network, and it writes the profile store and the state folder, both outside the project. With `TC_HOME` or `TC_APPS_STATE` set, pass `$TC_HOME/.tinycloud` and `$TC_APPS_STATE` instead. Folders under your home don't need to exist yet: the setup creates them. A missing `--add-dir` folder under `/tmp`, though, stops Codex's sandbox from starting, so create it first. |
| OpenCode | `opencode` | No questions. After the first setup, restart OpenCode once, as the agent will tell you: it loads skills only when it starts. Claude Code and Codex don't need a restart. |

Claude Code and Codex also ask whether you trust a folder the first time you start them in it.

Optional variables, set before you start the client:
- `TC_HOME`: the CLI profile store. Without it the CLI uses `~/.tinycloud`.
- `TC_APPS_STATE`: this skill's state folder. Default `~/.local/state/tc-apps`.
- `TC_BIN`: the absolute path to another `tc`, CLI `1.3.4` or later. The skill then runs it, not the CLI in its own folder. `TC_BETA_BIN` does the same for the `1.5.0-beta.2` CLI.

## What you see at sign-in

Each app has its own approval, the first time you track something new, and it lasts 30 days.

1. You ask, for example "Add a todo: renew my passport." The agent checks whether the `todos` app is signed in, then starts the sign-in.
2. The agent shows a link:

   > Open https://openkey.so/delegate?… and sign in to OpenKey. You will see "Update application data"; open "Advanced details" to see the folder `xyz.tinycloud.tinyapps.todos/` in your `applications` space and the permissions: key-value access to that folder for 30 days, reading the list of tiny apps and writing this app's entry in it, and a read of your permissions, which doesn't read your data. Approve, then paste here the code OpenKey shows.

3. Open the link, on this computer or your phone, and sign in to OpenKey. You will see "Update application data"; open "Advanced details" to see the folder `xyz.tinycloud.tinyapps.todos/` in your `applications` space and the permissions, key-value access to that folder and a read of your permissions (that doesn't read your data). Then approve.
4. OpenKey shows a code. Paste it in the chat, and the agent finishes the sign-in and carries on. Or paste it into your own terminal with the command the agent gives you.

One approval covers one app. A new app, such as `fitness`, asks once more; nothing covers all your apps at once. Every agent on this computer that uses the same `TC_HOME` shares the apps you've approved.

## What you can ask

- "Log my weight: 80.5 kg today." This starts a `fitness` app with a `weight` kind. Another value for the same day replaces the first, and the agent says so.
- "My goal is 78 kg by December." This adds a `goal` kind to `fitness`.
- "Bench press, 3 sets of 8 at 60 kg." This adds a `lift` kind.
- "Ran 5 km in 27 minutes." This adds a `session` kind. Later sports become new values of `sport`, and their details become new fields.
- "Add a todo: renew my passport." This starts a `todos` app. "Passport renewed" marks the todo done.
- "What do you keep for me?", "How far am I from my goal?", "My bench volume last week?"

When the agent creates an app or a kind, it tells you in one line. Meals, food, calories and recipes go to Health Log and Recipes, which have their own approvals.

## How your data is organised

Each app sits under its own folder in your `applications` space, `xyz.tinycloud.tinyapps.<app>/`:

```text
xyz.tinycloud.tinyapps.fitness/catalog                          what the fitness app is for
xyz.tinycloud.tinyapps.fitness/catalog/lift                     what a lift record holds: fields, units, how keys are formed
xyz.tinycloud.tinyapps.fitness/lift/2026-10/2026-10-06T1830-bench-press
xyz.tinycloud.tinyapps.fitness/weight/2026-10/2026-10-06
xyz.tinycloud.tinyapps.todos/todo/open/2026-10-06-renew-passport
xyz.tinycloud.tinyapps.catalog/fitness/entry                    one line per app, so any agent can find it
```

Each record is a small JSON document: `{"v":1,"at":"…","data":{…},"by":"claude-code"}`, where `by` is the client that wrote it.
- **The catalog** tells any agent what exists and how to read it.
- **Changes only add.** New fields and new kinds never break old records, and old records aren't rewritten.
- **New records are created, not overwritten.** The agent writes a new key with `--if-none-match '*'`, which refuses to replace an existing record. It replaces one only when you give a new value for a once-a-day record such as a weigh-in.

## Records from an earlier version

Earlier versions of this skill kept all apps together in your `default` space, under `xyz.tinycloud.agent-data/`. Those records stay there; nothing deletes them unless you ask. An app that has records there keeps working exactly as before, with no new approval. The agent tells you once per conversation: "This app can move to its own folder: say "move my <app> records" when you want it (nothing is deleted)."

If this computer has no current sign-in to the old place, the agent can't check it, so it asks whether you kept that app's records with an earlier version. Right after setup, the question comes in the same message as the app's approval link: if you did, say so instead of approving.

When you ask, the agent requests the app's own approval and gives you a script to run in your own terminal:

1. `sh migrate.sh --dry-run <app>` prints the plan and writes nothing.
2. `sh migrate.sh <app>` copies the records to the app's new folder, reads them back and compares them (the same keys, the same count, the same contents), checks the old place again for edits made meanwhile, and only then marks the app as moved and saves a receipt with counts and a digest.
3. If anything differs, or is refused, it stops with `NOT SWITCHED`, the old records are untouched, and the app keeps working in the old place. Fix the cause and run it again; keys that already match are recognised.

The app switches to its own folder only after step 2 printed success and its receipt exists. Pause other agents that write the app while it runs, and copy the receipt to your other computers before you use the app there. A move doesn't import old meal records into Health Log; they are moved as they are. An app with no old records starts in its own folder.

## Faster answers over many records

You don't need to set anything up. The first time a question needs many records of one app, such as "bench volume per week since August", the agent answers the slow way, reading them one by one. It then offers a faster way, a searchable copy of that app's records:

1. The agent shows an OpenKey link. Open it and sign in. Open "Advanced details" to see the request listed as SQL access to `xyz.tinycloud.tinyapps.fitness/index` in your `applications` space, for 30 days; that's the copy.
2. Approve. OpenKey then shows a short code, such as `ABCD-EFGH`. Paste it in the chat and the agent finishes the sign-in, or paste it into your own terminal with the command the agent gives you. A short code works once and expires within minutes; if it has expired, paste the full code OpenKey also shows.
3. The agent finishes, builds the copy from the app's records, and says when it's done. From then on it answers questions over many records of that app with one lookup, without reading every record. The agent's own thinking still takes most of the time.

If you ignore the offer, nothing breaks; the agent asks again in a later conversation that needs it.

Good to know:
- **Your records stay the truth.** The index is only a copy, and the agent rebuilds the parts that fall behind.
- **When the index expires** after 30 days, everything keeps working, more slowly, until you approve it again.
- **Don't rely on the database name as a boundary.** The approval names one database, but TinyCloud's node can also open other SQL databases in the same space. The agent only ever uses that app's index.
- **The code** is a permission slip for this computer's `tinyapp-<app>-sql` profile, so it's fine to paste in the chat. A short code only works for the sign-in that asked for it, works once, and expires within minutes.

## What the sign-ins grant

- **Records:** profile `tinyapp-<app>` can get, put, list and delete keys under `xyz.tinycloud.tinyapps.<app>/` in your `applications` space, read the list of apps under `xyz.tinycloud.tinyapps.catalog/`, and write that app's own entry there. Nothing else. Every OpenKey approval also lets it read which permissions it holds.
- **Index:** profile `tinyapp-<app>-sql` can read, write and change the schema of the SQL database `xyz.tinycloud.tinyapps.<app>/index` in your `applications` space.
- **Lifetime:** 30 days each, OpenKey's maximum. Afterwards the agent shows you a new link when it needs one.
- **Stopping:** each command below clears the local session for one app, with `TC_HOME` and `TC_BIN` set as when you started the client, so it uses the same CLI as the skill. The approvals stay valid on TinyCloud until they expire.

  ```sh
  B=${TC_BETA_BIN:-$HOME/.local/share/tc-apps/cli-beta/node_modules/.bin/tinycloud}
  "$B" --profile tinyapp-<app> auth logout
  "$B" --profile tinyapp-<app>-sql auth logout
  ```

  To remove the rest, delete `~/.local/share/tc-apps`, `~/.local/state/tc-apps`, and the `tc-apps` skill folders.

## Why it works this way

- **One folder and one approval per app.** Each app has its own key root, so an approval for `todos` can't read `fitness`, and a new app asks for its own approval. The price is one more approval per app.
- **Browser approval with a pasted code.** OpenKey allows the phone-code (device) approval only for the `default` space, so apps in `applications` use the browser approval, where you paste a code back.
- **KV first, SQL as a copy.** Key-value records survive agent mistakes, because each record is its own key. The SQL index is rebuildable, so it never holds the only copy of anything.
- **Reads run side by side.** Each storage command takes 3–5 s against TinyCloud, so the agent fetches up to eight records at once.
- **Literal paths in commands.** Claude Code can remember an approval only for a command it can work out from the text.

## Rough edges

- If you approve with a different account or key than the profile's first sign-in, the sign-in fails with `OPENKEY_OWNER_MISMATCH`. Ask again and use the same one.
- A brand-new account's space finishes setting up a minute or two after the first approval. Until then reads and writes fail with `SPACE_NOT_HOSTED`: the agent tells you it's still being set up and retries for about two minutes. If it's still not ready, the agent says so and stops; try again in a few minutes. It never asks for a second sign-in to fix this.
- When your TinyCloud storage is full, saves fail with `STORAGE_QUOTA_EXCEEDED` or `STORAGE_LIMIT_REACHED` and nothing is saved; your records are still readable. The agent tells you and doesn't retry. To keep saving, upgrade at https://account.tinycloud.xyz/storage; deleting records doesn't free space yet.
- Two agents changing the same kind's description in the same few seconds can lose one change; the next agent re-adds it.
- `tinycloud-explorer` doesn't show these apps yet.
