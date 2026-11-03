# CLI Command Reference, part 4: artifacts, KV input, profile directory and DIDs

Part 4 of the CLI command reference. The entry point is [REFERENCE.md](REFERENCE.md). `### Artifacts` continues the share publish section in [REFERENCE-3.md](REFERENCE-3.md#share-publish-inspect-receive-list-revoke).

### Artifacts

An artifact is a file an agent publishes for a person to open in the Share viewer. Publish it as a bearer link, the default: HTML renders for link recipients only and an addressed (`--to email:` / `did:` / `domain:`) HTML file is offered as a download; JSX follows the same rule once the JSX renderer ships, and until then it is shown as source text with a Download action. One file per artifact; folders and multi-file bundles are not supported.

| Kind | File | What the viewer does |
|------|------|----------------------|
| Markdown | `report.md` | Renders GFM (tables, task lists, fenced code), sanitized; data: images only |
| HTML | `page.html`, one self-contained file | Runs it in an isolated sandbox with no network: inline all CSS, scripts and images (`data:` URIs); links to other URLs and external scripts, fonts and stylesheets do not load |
| HTML folder | `./site/` with a top-level `index.html`, bearer links only | Not a separate kind: `share publish ./site/` inlines the folder's CSS, scripts, images and fonts into one self-contained page at publish time and publishes that single `.html` (named `site.html`, or `--name`). The page can use only what the folder holds: external URLs, frames, forms, `<base>`, module scripts and links to other pages are refused with a typed error naming the file and reference (`UNSUPPORTED_HTML`, `HTML_RESOURCE_MISSING`, `UNSAFE_PATH`, `UNSUPPORTED_FOLDER_ENTRY`, `MAX_BYTES_EXCEEDED`). Symbolic links and names starting with `.` are never read. An `@import`ed stylesheet can only hold rules: if it uses `url()` the folder is refused, so put images and fonts in the page's own stylesheet or `<style>`. `manifest.json` and `knowledge/**` stay out of the page and are not published. Addressed and `--prefix` folder publishing is not available (refused with `MAX_BYTES_EXCEEDED`, exit 7, saying so) |
| JSX | `App.jsx` / `App.tsx` with a default-export component | Compiles and renders it in the same kind of sandbox once the viewer release that adds JSX rendering is live; until then the file is shown as source text with a Download action |

JSX: `export default function App() { ... }`, no `ReactDOM.render`, no CSS file. Imports resolve only from this library set: `react` (19), `react-dom/client`, `lucide-react`, `recharts`, `d3`, `mermaid` (11), plus Tailwind utility classes. Any other import fails with an error panel listing the set; bundle other code into the file or publish a self-contained HTML page. Fetching data is not possible (no network): embed the data in the file.

Style with the TinyCloud tokens so the artifact follows the viewer's light and dark theme: `var(--tc-color-page|surface|surface-subtle|text|text-muted|border|accent|on-accent|link)`, `var(--tc-color-status-success|warning|danger|info)`, `var(--tc-space-1…7)`, `var(--tc-radius-sm|md|lg)`, `var(--tc-font-sans|mono)`, `var(--tc-text-xs…2xl)`. HTML artifacts receive the custom properties only (no base styles), so set `body { background: var(--tc-color-page, #fff); color: var(--tc-color-text, #1a1c21); font-family: var(--tc-font-sans, system-ui, sans-serif); }` yourself and keep fallbacks for viewers that predate the tokens.

```bash
# 1. Publish; the JSON carries the share id and the artifact id, never the link
tinycloud --profile publisher share publish ./report.md --to anyone --artifact new --json
#    {"metadata":{"shareId":"…"},"artifactId":"art_…","version":1,"mode":"pinned", …}

# 2. Get the link: a second call. Write it straight to a private file
tinycloud --profile publisher share show <shareId> --reveal-link

# 3. Revise: publish the next pinned version; it gets its own link, and earlier links keep showing the version they pinned
tinycloud --profile publisher share publish ./report-v2.md --to anyone --artifact art_0123456789abcdef --json

# 4. Take a link down; the node confirms before it reports revoked
tinycloud --profile publisher share revoke <shareId>
```

- Default to `--to anyone` for artifacts unless the person you are working for named a narrower audience. Choose `--expires` deliberately (the default is `7d`). Anyone holding the complete URL can open it until it expires or is revoked, and revoking does not recall copies already received. For content that only named people may read, use `--to email:` and tell the recipient it will download rather than render.
- `--artifact new` pins: the link reads the one version published, and the CLI never overwrites a version (the next publish writes the next one). Use it whenever the artifact may be revised; `share versions <artifact-id>` lists the versions and the shares pinned to each. A pinned share is read-only, so `--action edit` is refused with it, and `--to anyone --action edit` is refused for every share.
- Give the person the link from `share show <shareId> --reveal-link` once; do not write it to logs, issue comments or shared files. `share publish --json` never has the link, and `share show --reveal-link` refuses `--json`, so a log of JSON output never holds it.
- Never put secrets, tokens or private keys in an artifact. The source is stored in the owner's space and its bytes are readable by every link holder.
- Limits: one file; the viewer renders sources up to 1 MB and offers larger ones as a download.

## KV Put Input Sources (mutually exclusive)

| Source | Example |
|--------|---------|
| Argument | `tinycloud kv put key "value"` |
| File | `tinycloud kv put key --file ./data.txt` |
| Stdin | `echo "data" \| tinycloud kv put key --stdin` |

KV keys cannot contain spaces or control characters: the SDK sends keys unescaped in the node resource URI, so `get`, `put`, `head`, `delete` and `list --prefix` refuse them with `USAGE_ERROR` (exit 2) before authenticating. A `put` on full storage returns the general storage-full error (exit 10).

## Profile Directory Structure

```
~/.tinycloud/                      # 0700
├── config.json                    # Global config (defaultProfile)
├── profile-locks/
│   └── {name}/                    # Turn lock (see below); kept after `tinycloud profile delete`
│       └── .live-<dir>-<id>       # Socket of an acquisition in progress (Linux)
└── profiles/
    └── {name}/                    # 0700
        ├── profile.json           # Host, DID, chainId, ownerDid, spaceId (0600)
        ├── key.json               # Ed25519 JWK keypair (0600)
        ├── session.json           # Delegation, spaceId (0600)
        ├── additional-delegations.json        # Imported and granted delegations, with request bindings (0600)
        ├── auth-requests.json                 # Stored permission requests (0600)
        ├── delegation-binding-migration.json  # Present once unbound records were migrated (0600)
        ├── .lock/                 # Lock shared with older releases, while held
        └── cache/
```

### Profile lock

Every write to a profile (key, session, settings, delegations, permission requests) runs under the profile's lock, shared by `tinycloud` and the MCP server. Processes of this release first take a turn in `profile-locks/{name}/`, then the `profiles/{name}/.lock` directory every release uses, so they keep excluding CLI 1.0.0-beta.16 and older (which hold `.lock` from its creation) and 1.0.0-beta.17 … 1.0.1-beta.4 (which hold it once `owner.json` is linked in), and those exclude them. Among processes of this release, mutual exclusion holds however long any of them is paused, and needs no hard links (FAT/exFAT and SMB mounts work).

That guarantee assumes every process using the profile runs on the same host and in the same PID namespace (a crashed process is recognised by its PID being gone), and a filesystem whose `rename` of a directory fails when the target exists. It does not hold for a `TC_HOME` shared across machines (NFS) or between containers that do not share a PID namespace: there a live process can look crashed, have its turn or staging directory removed, and the lock can be taken twice or stop working. The one case this release handles across PID namespaces is a record that carries the checking process's own PID, below. Older releases running at the same time keep their own limits: a 1.0.0-beta.16-or-older process paused for longer than 30 s right after creating `.lock`, or a 1.0.0-beta.17 … 1.0.1-beta.4 process reclaiming `.lock` at the same moment as such a process, can still let two writers in. CLI 1.0.0-beta.16 and older never reclaim an abandoned `.lock` without an owner record; a newer release does, once it is 30 s old.

A record with the checking process's own PID says nothing by its PID: a restarted container's `tinycloud-mcp-http` is PID 1 again, and so is a live MCP server in another container sharing the volume. Owner records written by this release therefore also carry a process-wide instance ID and, on Linux, the kernel boot ID, PID namespace and process start time. Each acquisition on Linux also listens on a UNIX socket in its turn directory, `profile-locks/{name}/.live-<dir>-<id>`, whose name records that directory's device and inode, from before its first turn record until it has released the lock; the socket appears under that name only once it accepts connections. A record with this process's PID and another instance ID counts as abandoned only if it comes from the same kernel boot and one of these holds:

- It comes from the same PID namespace with a different process start time: the PID was reused. This needs no socket, and works under Bun too.
- It comes from another PID namespace, its socket was bound in the very turn directory this process uses (the same device and inode, so a bind mount of that directory qualifies), and either the socket is gone or the kernel refuses connections to it. Only the holder removes its socket, after releasing, or a process that saw it refused; the kernel refuses connections only once the holder has closed the socket or exited, so a live holder, paused or not and under any hostname, is waited for. A refusal counts only if this process can then connect to its own socket in the same directory. That catches a sandbox that refuses every connection, such as a seccomp filter returning ECONNREFUSED for all connects. It does not catch a sandbox that fabricates refusals selectively: a seccomp filter keyed on the call's arguments, a seccomp user-notification supervisor, or a BPF LSM program. The lock trusts the kernel's answers here, as its PID check trusts kill(2). A sandbox that fakes either answer can make a live holder look gone, and is unsupported. Under Bun a refusal never counts, because Bun reports a refused connection as a missing file; a removed socket does.

Every other same-PID record is waited for, as before: records from older releases; a different boot ID (the host or VM rebooted, or the volume moved to another machine); a holder that could not create its socket (a filesystem without socket files, no `/proc`); a socket bound in a different turn directory than the one this process uses (`profile-locks/` not shared while `profiles/` is, a turn directory removed and recreated, or one reached through a mount with different device numbers, such as a second mount of a network share); a checking process that cannot create its own socket or connect to it; refusals seen under Bun; and macOS and Windows. If such a record's process is gone, writes to that profile fail with `PROFILE_LOCK_TIMEOUT` (`ProfileLockTimeoutError`), without the damaged-turn detail, until it is cleared. **Only while no `tinycloud` or MCP process uses that profile**, remove its turn directory and its `.lock`:
- `tinycloud` and the stdio MCP server (`tinycloud-mcp`): `$TC_HOME/.tinycloud/profile-locks/{name}` and `$TC_HOME/.tinycloud/profiles/{name}/.lock` (without `TC_HOME`, `~/.tinycloud/…`).
- The HTTP MCP server (`tinycloud-mcp-http`, the container image), for each affected tenant: `$TC_MCP_STATE_DIR/tenants/{tenant}/.tinycloud/profile-locks/agent` and `$TC_MCP_STATE_DIR/tenants/{tenant}/.tinycloud/profiles/agent/.lock` (`TC_MCP_STATE_DIR` is `/var/lib/tinycloud-mcp` in the image).

Never remove a `.live-*` socket or a turn directory while a process may hold the lock: a removed socket counts as a finished holder. Sockets left by processes that are gone are removed by a later acquisition (under Node) once the kernel refuses them.

A crashed holder's lock is reclaimed automatically (`.lock` once 30 s old). With hard links, dead-owner recovery keeps a `.recover-*` claim inside `.lock` until it finishes; it never unlinks or moves a newly published live owner, and a failed claim never removes another writer's empty `.lock`. A crashed current-release recoverer may leave only a `.recover-*` claim. Releases through 1.0.1-beta.4 cannot reclaim it even after it ages. A current-release command that acquires the affected profile's lock processes the claim, restoring a live owner's record if it contains one.

On either recovery path, an orphaned `.recover-*` claim can hold a replacement owner's live record: the hard-link path may claim it before detecting a mismatch, and the no-hard-links path may move it before putting it back. If the recoverer crashes and that holder releases while its process stays alive, the next acquisition restores the claimed record as `owner.json`. Acquisition can then remain blocked until the PID exits **and** the record is at least 30 s old—for a long-lived MCP server, possibly until it restarts. This costs availability only; it never admits a second holder. To clear the stalled profile manually, remove its `profiles/{name}/.lock` **only when no `tinycloud` or MCP process is running**.

`PROFILE_LOCK_TIMEOUT` naming `profile-locks/{name}` means its turn lock is damaged (for example by a disk error): when no `tinycloud` or MCP process is using that profile, remove `~/.tinycloud/profile-locks/{name}`; it is recreated on the next write. A write that waited for the lock while `tinycloud profile delete` removed the profile fails with `PROFILE_NOT_FOUND` instead of recreating it.

## DID Formats

- **Session key**: `did:key:z6Mk...#z6Mk...` — generated at init
- **Owner DID**: `did:pkh:eip155:{chainId}:{address}` — after auth

Use `--json` for machine-readable output; interactive commands can render human output. General command errors go to stderr as `{error: {code, message, hint?, recovery?, setup?, progress?, meta?, warnings?}}` (`recovery`, `setup` and `progress` are described under [Secrets](REFERENCE-2.md#asking-the-owner-for-a-secret-request-wait-manage)). `meta` contains a typed HTTP `status` and, only when validated as a TinyCloud capability (and against the KV request when available), a `resource` and `requiredAction`. Inspect the structured code, not only the exit status.

General storage/auth exit codes: 0 success, 1 operation error (including `PROFILE_MIGRATION_REQUIRED` and `PROBE_FAILED`), 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, 7 node error, 8 pending (`tinycloud secrets wait`; `onboard` and `auth grant` with `--timeout`, where it is an approval still pending or OpenKey not reachable), 10 storage full, 130 interrupted (`CANCELLED`). `tinycloud share` uses its own: 1 profile lock timeout, sender-history retry or unconfirmed revocation (`PROFILE_LOCK_TIMEOUT`, `SHARE_HISTORY_RETRY`, `SHARE_REVOKE_UNCONFIRMED`), 3 upload authority required, 4 unavailable, expired, revoked bearer link, upload failed or revocation refused (`SHARE_LINK_UNAVAILABLE`, `SHARE_REVOKED`, `SHARE_REVOKE_REJECTED`), 5 permission denied (`PERMISSION_DENIED`, `SHARE_ISSUER_KEY_UNAVAILABLE`) or verification failed, 6 recipient authorization required or network error, 7 byte limit, 8 output conflict or unsafe filename, 9 partial success, 10 storage full.

`tinycloud secrets run` exits with its command's status once the command has started. Before that it uses the codes above, plus 126 (the command cannot be executed or started) and 127 (the command does not exist).

For `tinycloud kv get|put|head|list|delete`, `tinycloud space list|host`, `tinycloud sql`, `tinycloud vault`, `tinycloud vars`, `tinycloud duckdb`, `tinycloud secrets list|put|delete`, `tinycloud delegation`, and `tinycloud account`, service-result errors use typed authorization: a plain HTTP 401 is `AUTH_REQUIRED` (exit 3); a 403 is `PERMISSION_DENIED` (exit 5). A 401 with a validated missing capability, or `AUTH_UNAUTHORIZED` without an HTTP status, is `PERMISSION_DENIED` (exit 5); a validated capability also produces a `tinycloud auth request --cap` hint. This changes the former exit 1 for status-less `AUTH_UNAUTHORIZED` in the listed commands. Other HTTP failures retain their service-specific codes. `tinycloud share` has separate exit mappings below.

Every command that writes reports full TinyCloud storage the same way: `STORAGE_QUOTA_EXCEEDED` (storage is full) or `STORAGE_LIMIT_REACHED` (this write is larger than what is left), exit 10, with nothing written (`tinycloud sql copy` instead names the table and the rows it had already copied). The hint gives the account totals when the node reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/storage. Retrying cannot succeed until the owner frees up space or upgrades.
