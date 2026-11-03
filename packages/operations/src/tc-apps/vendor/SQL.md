# The SQL index (tc-apps)

Part of the `tc-apps` skill: read `SKILL.md` first. For one generic app, `<APP>`, the index copies records into `xyz.tinycloud.tinyapps.<APP>/index` in the same owner's `applications` space. KV remains the source of truth. Reuse existing SQL access; do not request another sign-in merely because this is an index.

- **Profile:** `<INDEX_PROFILE>` is selected below; it can be the already-onboarded profile or an existing `tinyapp-<APP>-sql` profile for the same owner and host.
- **Approval:** only missing SQL actions, through a short OpenKey link. No pasted code is needed.
- **Scope:** use only this app's database. Do not rely on a database name as a boundary on older nodes.

Use the same literal `<TC_BIN>` and `<STATE>` as `SKILL.md`. Copy `<INDEX_PROFILE>` from the helper below; its `ownerDid`, `host` and `spaceId` must match the app's `<APP_HOST>` and `<APP_SPACE>` context. Keep SQL parameters separate from statements. Put options before `--` and SQL after it.

**Never run two SQL writes at the same time.** That includes another block of yours, and `xargs`. Parallel writes to one database can fail, or half-apply. Writes in this file run one after another; only reads run side by side.

**Keys in the index are relative:** `<kind>/<folder>/<id>`, the KV key without its `xyz.tinycloud.tinyapps.<APP>/` root.

## 1. Reuse access or ask for the fast copy

Run the installed `app-context.mjs` with `--sql --write`:

```sh
for d in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/tc-apps" "$HOME/.agents/skills/tc-apps"; do if [ -f "$d/app-context.mjs" ]; then node "$d/app-context.mjs" '<TC_BIN>' '<APP>' --sql --write; break; fi; done
```

- `ready`: copy its profile as `<INDEX_PROFILE>`. No approval is needed for the read/write access already granted. If `indexPresent` is true, continue with the existing index. If false, repeat the helper with `--sql --write --schema` before §2.
- `grant-required`: on the returned profile, request only the missing actions in one command. For example, when only schema authority is missing:

  ```sh
  TC_BIN='<TC_BIN>'; umask 077
  "$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' auth request --cap 'tinycloud.sql:applications:xyz.tinycloud.tinyapps.<APP>/index:schema' --grant --no-popup --expiry 30d
  ```

- `sign-in-required`: sign in the returned index profile with an applications-space manifest for `tinycloud.sql` on `xyz.tinycloud.tinyapps.<APP>/index`, containing only the required `read`, `write` and, for a new table, `schema` actions. Use `auth login --method openkey --no-popup --manifest FILE --expiry 30d`, creating a key-only profile only if it is absent.

  ```json
  {
    "app_id": "xyz.tinycloud.tinyapps.<APP>",
    "name": "<APP> searchable copy",
    "space": "applications",
    "defaults": false,
    "permissions": [
      {"service": "tinycloud.sql", "path": "xyz.tinycloud.tinyapps.<APP>/index", "actions": ["read", "write", "schema"], "skipPrefix": true}
    ]
  }
  ```

  Keep only the actions the helper reports missing; schema access is for creation, not ordinary reads or updates.
- An owner/host mismatch or actual read failure stops the index operation. Answer from the original KV records; do not switch accounts or widen the grant.

When additional approval is necessary, first answer from the KV records you already read. Explain that the missing permission enables a fast, searchable copy, show the actual short URL on its own line, and keep the command running. The owner approves; the CLI retrieves the result automatically. After interruption, rerun the same command/profile. Never add `--paste`, reconstruct a URL or ask the owner to run a command.

After successful approval, repeat the helper. For a new index, run §2, then rebuild every kind with §6, skipping its clearing step because the table is empty. If the owner declines, leave the records unchanged and continue with KV reads.


## 2. Create the table and the view

Run once, after the first sign-in. It's harmless to run again.

```sh
TC_BIN='<TC_BIN>'; umask 077
"$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql execute --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json -- "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, rec TEXT NOT NULL)"
"$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql execute --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json -- "CREATE VIEW IF NOT EXISTS entries AS SELECT key, kind, substr(r2, 1, instr(r2, '/') - 1) AS folder, substr(r2, instr(r2, '/') + 1) AS id, substr(r2, instr(r2, '/') + 1, 10) AS day, json_extract(rec, '\$.v') AS v, json_extract(rec, '\$.at') AS at, json_extract(rec, '\$.by') AS by, json_extract(rec, '\$.data') AS data, rec FROM (SELECT key, rec, substr(key, 1, instr(key, '/') - 1) AS kind, substr(key, instr(key, '/') + 1) AS r2 FROM records)"
```

- **`records`** holds one row per KV record: its relative key, and the record as stored.
- **`entries`** splits the key into `kind`, `folder` and `id`. `folder` is the month for a log kind and the state for an item kind. `day` is the date the id starts with.
- **`v`, `at`, `by` and `data`** come straight from the record; read fields with `json_extract(data, '\$.<field>')`.

Then fill the index: rebuild every kind the app's catalog lists (§6).

## 3. Keep the index in step

Do this after every record write, status change or deletion when an index already exists. Use `<APP_PROFILE>` for KV and `<INDEX_PROFILE>` for SQL, both for the same owner, host and space. List each affected key relative to `xyz.tinycloud.tinyapps.<APP>/`.

```sh
TC_BIN='<TC_BIN>'; STATE='<STATE>'; umask 077
printf '%s\n' '<kind>/<folder>/<id>' '<kind>/<folder>/<id>' | xargs -P 8 -I{} sh -c 'R=$("$0" --profile "<APP_PROFILE>" --host "<APP_HOST>" kv get "xyz.tinycloud.tinyapps.<APP>/$1" --raw --space "<APP_SPACE>" 2>/dev/null); c=$?; if [ $c -eq 0 ]; then printf "{\"k\":\"%s\",\"r\":%s}\n" "$1" "$R"; elif [ $c -eq 4 ]; then printf "{\"k\":\"%s\"}\n" "$1"; else printf "{\"k\":\"%s\",\"r\":}\n" "$1"; fi' "$TC_BIN" {} > "$STATE/rows"
ROWS=$(sed 's/\\/\\\\/g; s/"/\\"/g' "$STATE/rows" | paste -s -d, -)
"$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql execute --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json --params "[\"[$ROWS]\"]" -- "INSERT OR REPLACE INTO records (key, rec) SELECT json_extract(value, '\$.k'), json_extract(value, '\$.r') FROM json_each(?) WHERE json_extract(value, '\$.r') IS NOT NULL" && "$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql execute --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json --params "[\"[$ROWS]\"]" -- "DELETE FROM records WHERE key IN (SELECT json_extract(value, '\$.k') FROM json_each(?) WHERE json_extract(value, '\$.r') IS NULL)"
```

- **Two `{"changes": …}` lines** → done.
- **`SQL_ERROR` about malformed JSON** → a KV read failed on the way. Run the block again once.
- **`NETWORK_ERROR`** ("superseded checkpoint") → another write hit the index at the same moment. Run the block again once; it's safe to repeat.
- **Up to 200 keys per block.** For more, run it again with the next 200.

If the block still fails, or `SKILL.md` §3 showed the index's session `"expired"`, mark the kind as behind, once per kind you touched, so the next agent with a working index rebuilds it:

```sh
TC_BIN='<TC_BIN>'; umask 077
"$TC_BIN" --profile '<APP_PROFILE>' --host '<APP_HOST>' kv put 'xyz.tinycloud.tinyapps.<APP>/index-stale/<kind>' --stdin --space '<APP_SPACE>' --json <<'EOF'
{"since":"<today's date>","by":"<your client>"}
EOF
```

## 4. Check before answering

Before you answer from the index, check every kind the question covers. Repeat the `sql query` line and the second `kv list` line for each kind, keeping them in this order.

```sh
TC_BIN='<TC_BIN>'; umask 077
"$TC_BIN" --profile '<APP_PROFILE>' --host '<APP_HOST>' kv list --prefix 'xyz.tinycloud.tinyapps.<APP>/index-stale/' --space '<APP_SPACE>' --all --json
"$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql query --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json --params '["<kind>/"]' -- "SELECT count(*) AS n FROM records WHERE instr(key, ?) = 1"
"$TC_BIN" --profile '<APP_PROFILE>' --host '<APP_HOST>' kv list --prefix 'xyz.tinycloud.tinyapps.<APP>/<kind>/' --space '<APP_SPACE>' --all --json | grep '"count"'
```

- **The kind isn't under `index-stale/`, and `n` equals `"count"`** → the index is in step for that kind: §5.
- **Otherwise** → rebuild that kind (§6), then answer.
- **`ERROR` "SIWE is expired", or `AUTH_REQUIRED`** → the fast copy needs a new approval. Answer from KV (`SKILL.md` §5), then ask for it with §1, at most once per conversation.

## 5. Query

```sh
TC_BIN='<TC_BIN>'; umask 077
"$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql query --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json --params '[<values>]' -- "<SELECT …>"
```

It prints `{"columns": […], "rows": [[…]], "rowCount": …}`. Query the `entries` view. Pass values as `?` parameters in `--params`, a JSON array, and never paste values into the SQL. Inside the SQL, write each `$` as `\$`. Leave `%` as it is, for example `strftime('%Y-%W', day)`.

Examples. The kind and field names here are illustrations; use the ones the app's catalog records give:
- **Weight since a date (app `fitness`):** `SELECT day, json_extract(data, '\$.kg') AS kg FROM entries WHERE kind = 'weight' AND day >= ? ORDER BY day`
- **Weekly volume for one exercise (app `fitness`):** `SELECT strftime('%Y-%W', day) AS week, sum(json_extract(data, '\$.sets') * json_extract(data, '\$.reps') * json_extract(data, '\$.kg')) AS volume FROM entries WHERE kind = 'lift' AND json_extract(data, '\$.exercise') = ? GROUP BY week ORDER BY week`
- **Open items (app `todos`):** `SELECT id, json_extract(data, '\$.title') AS title FROM entries WHERE kind = 'todo' AND folder = 'open' ORDER BY id`
- **Everything on a day:** `SELECT kind, id, data FROM entries WHERE day = ? ORDER BY kind, id`

Rules:
- Use only `SELECT` and `WITH`. Never `PRAGMA`, `GLOB` or `RETURNING`. One statement per command.
- To see a kind's fields, read its catalog record; don't inspect the table.
- `rec` and `data` come back as JSON text: read the fields you need with `json_extract`.
- Say how many records the answer covers.

## 6. Rebuild a kind

Rebuild when §4 finds a kind behind, and for every kind after the first sign-in.

1. List the kind's keys with `SKILL.md` §5, using the prefix `xyz.tinycloud.tinyapps.<APP>/<kind>/`, and drop the `xyz.tinycloud.tinyapps.<APP>/` root from each key.
2. Clear the kind's rows, unless the copy was just created in §1 and is still empty:

   ```sh
   TC_BIN='<TC_BIN>'; umask 077
   "$TC_BIN" --profile '<INDEX_PROFILE>' --host '<APP_HOST>' sql execute --db xyz.tinycloud.tinyapps.<APP>/index --space '<APP_SPACE>' --json --params '["<kind>/"]' -- "DELETE FROM records WHERE instr(key, ?) = 1"
   ```

3. Copy exactly the keys step 1 listed, all of them, with §3's block: at most 200 keys per block, one block after another. Never build key names yourself, for example from dates.
4. Remove the kind's mark, if §4 listed one:

   ```sh
   TC_BIN='<TC_BIN>'; umask 077
   "$TC_BIN" --profile '<APP_PROFILE>' --host '<APP_HOST>' kv delete 'xyz.tinycloud.tinyapps.<APP>/index-stale/<kind>' --space '<APP_SPACE>' --json
   ```

5. Run §4's block once, with its lines for every kind you rebuilt. Report `n` and `"count"` for each: they must be equal.

## 7. Lifetime and errors

- **The index session lasts 30 days.** `SKILL.md` §3's `context` shows `"state": "present"` while it's valid, and `"expired"` afterwards. While it's expired, writes mark kinds behind (§3), and reads use KV. The next time an answer needs many records, ask for a new approval with §1.
- **`AUTH_UNAUTHORIZED` ending in `tinycloud.sql/schema`** → the owner unchecked the schema permission (§1b). Everything except §2 still works.
- **`SQL_ERROR` "no such table" or "no such view"** → run §2, then §6 for every kind.
- **`SQL_PERMISSION_DENIED`** → the statement type isn't allowed: rewrite it with `SELECT` or `WITH`.
- Anything else → `SKILL.md` §8.
