# Erasing one account's hosted MCP connector data

Runbook for an emailed request to erase what the hosted MCP server (`https://mcp.tinycloud.xyz`, Phala CVM `tinycloud-mcp`) stores for one account. It covers the connector's own state on the CVM volume only. Line references are to `packages/mcp` at master `cd055616`.

**Deadline.** The privacy policy (§14) promises a reply within 30 days. This runbook sets no other deadline.

**Completeness.** Every request covers all five state roots (`/mcp`, `/chatgpt/mcp`, `/claude/mcp`, `/grok/mcp`, `/muse/mcp`) and `native-tenants/`. Do this every time, even if the account says it used only one client.

## Roles

| Role | Does |
|---|---|
| Privacy contact | Receives the email, verifies the requester, owns the ticket, replies to the requester. |
| OpenKey operator | Maps the email to the OpenKey account's OAuth subject(s) and owner DIDs; revokes the account's MCP OAuth grants. |
| TinyCloud One operator | Confirms whether the account was enabled for TinyCloud One's MCP transcript path, and which chain id that path uses. |
| MCP operator | Runs the steps on the CVM. Has Phala access with an SSH key. |

Identifiers (email, subject, address) stay in the ticket. Do not paste them into chat, commits or logs.

## What the connector stores

All state lives on the `mcp-state` volume, mounted at `/var/lib/tinycloud-mcp` (`TC_MCP_STATE_DIR`, `docker-compose.phala.yml:8,21`). There are two kinds of record.

**OAuth tenants (one per OpenKey subject, per surface).** The directory name is `HMAC-SHA256(TC_MCP_STATE_SECRET, "tenant:" + subject)` in hex (`remote-store.ts:1679-1681`). The same subject gives the same id on every surface, because all five surfaces share the secret (`http.ts:114-119`). Only the parent directory differs:

```text
/var/lib/tinycloud-mcp/tenants/<id>            /mcp
/var/lib/tinycloud-mcp/chatgpt/tenants/<id>    /chatgpt/mcp
/var/lib/tinycloud-mcp/claude/tenants/<id>     /claude/mcp
/var/lib/tinycloud-mcp/grok/tenants/<id>       /grok/mcp
/var/lib/tinycloud-mcp/muse/tenants/<id>       /muse/mcp
```

Under `<id>/.tinycloud/profiles/agent/` (`remote-store.ts:1689-1711`):

| File | Holds |
|---|---|
| `key.json` | The connector's session key for this account. |
| `profile.json` | The session DID and node host; after the first approval, also the owner DID and space id. |
| `session.json` | The delegated session. |
| `additional-delegations.json` | Extra delegations. |
| `pending/<nonce>.json` | Open approval requests, including the owner DIDs from the OAuth token. |
| `auth-requests.json` | Approval bookkeeping. |
| `tc-apps.json` | The account's tc-apps settings (timezone). |
| `.lock` and `delegation-binding-migration.json` | Bookkeeping, written by `@tinycloud/operations`. |

**Native tenants (TinyCloud One's transcript grant, `/mcp` only).** The directory name is `HMAC-SHA256(TC_MCP_STATE_SECRET, "native-tenant:" + ownerDid)` in hex. Here `ownerDid` is the canonical `did:pkh:eip155:<decimal chain id>:<lowercase address>` (`remote-store.ts:332-338`, `native-auth.ts:27-33`). The path is `/var/lib/tinycloud-mcp/native-tenants/<id>/`. It holds `.tinycloud/native-grant.json` (the signed delegation, owner DID, space id, permissions and expiry) plus the profile, key and session files. Restricted surfaces never take native grants (`http.ts:116`).

Disconnecting is not deleting:
- **"Disconnect agent" in TinyCloud One** revokes the grant on the TinyCloud node and leaves every file in the native tenant in place. An expired grant also stays on disk.
- **Disconnecting a client** (ChatGPT, Claude and so on) leaves its tenant in place.
- Nothing in the server deletes a tenant directory. Only these steps remove one.

## 1. Verify and map

1. The privacy contact confirms the request came from the account holder.
2. **Email known to OpenKey.** The OpenKey operator returns:
   - every OAuth subject (`sub`) OpenKey has issued for the account to any of the five MCP resources;
   - every owner DID on the account (the `https://tinycloud.xyz/owner_dids` claim, `oauth.ts:13`).

   The MCP server never sees the email (`http.ts:659-669`), so only OpenKey can make this mapping.
3. **Email cannot be mapped** (no email on file, or the OpenKey account is already deleted). Ask the requester for the wallet address (`0x…`) the account signed in with. Addresses are public, so require proof of control before acting, for example a message signed by that address that names the request. From the address alone:
   - **Native tenants:** found by scanning each native grant's owner DID (step 3, `find`). This covers every chain.
   - **OAuth tenants:** found only where a file still names the address:
     - `profile.json` after a completed approval;
     - a `pending/` request that has not yet been cleaned up.

     A tenant that never completed an approval holds no address, so the address cannot find it. Such a tenant holds only the connector's key, session DID, node host and timestamps. Once a tenant id is found on any one surface, step 4 deletes that id on all five surfaces. That also covers surfaces where the tenant holds no address.
4. Record in the ticket which path was used (email or address) and why.

## 2. Stop new writes first

The server recreates an OAuth tenant on the next request from a still-authorised client (`http.ts:172-174`, `remote-store.ts:1365-1414`). It also rewrites the native tenant when TinyCloud One posts a new grant. So, before deleting:

1. The OpenKey operator revokes the account's OAuth grants and refresh tokens for all five MCP resources, unless the OpenKey account is already deleted.
2. If the account was on TinyCloud One's MCP transcript path, the TinyCloud One operator removes it from `MCP_CHAT_TEST_ACCOUNTS` (or confirms it was never listed).
3. Wait at least `TC_MCP_APPROVAL_TTL_SECONDS` (900 s in `docker-compose.phala.yml:15`). This lets any approval that was already open expire; otherwise a collection that finishes after the delete could write into a recreated directory.

## 3. Find the tenant ids on the CVM

**Check the OS first.** Shell access exists only on a dev OS image. The deploy pins the production image `dstack-0.5.12` and allows one dev image (`mcp-image.yml:26-28`, `.github/scripts/phala-dev-os-allowlist.txt`).

```bash
phala cvms get tinycloud-mcp --json | jq '.os.is_dev'
```

If this prints `false`, there is no SSH. **Stop** and escalate: this runbook cannot be carried out on that image. Do not change the OS image to get in.

**Open a shell and stage the helper.** Open a shell with `phala ssh tinycloud-mcp`. Every command below runs inside the `mcp` container as its own user, so the state secret stays in the container and is never printed. Write the helper to a private directory on the CVM:

```bash
W=$(mktemp -d)
cat > "$W/erase-account.cjs" <<'JS'
"use strict";
// Hosted MCP account erasure helper. Runs inside the mcp container: node - < erase-account.cjs
// Prints tenant ids, paths and file counts only; never file contents or the state secret.
const { createHmac } = require("node:crypto");
const { existsSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const fail = (message) => { console.error(`STOP: ${message}`); process.exit(1); };
const STATE = process.env.TC_MCP_STATE_DIR || fail("TC_MCP_STATE_DIR is not set");
const SURFACES = ["root", "chatgpt", "claude", "grok", "muse"];
const ID = /^[0-9a-f]{64}$/;
const DID = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const list = (name) => (process.env[name] || "").split("\n").map((v) => v.trim()).filter(Boolean);
const canonical = (did) => {
  const m = DID.exec(did);
  if (!m) fail(`not an eip155 did:pkh: ${did}`);
  return `did:pkh:eip155:${Number(m[1])}:${m[2].toLowerCase()}`;
};
const addressOf = (did) => (typeof did === "string" ? DID.exec(did.split("#", 1)[0])?.[2].toLowerCase() : undefined);
const tenantsDir = (surface) => (surface === "root" ? join(STATE, "tenants") : join(STATE, surface, "tenants"));
const nativeDir = join(STATE, "native-tenants");
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const children = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => ID.test(name)) : []);
const countFiles = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
const ids = (name) => list(name).map((id) => (ID.test(id) ? id : fail(`${name} holds a value that is not a 64-hex id`)));
const targets = () => {
  const dirs = [
    ...ids("ERASE_TENANT_IDS").flatMap((id) => SURFACES.map((s) => join(tenantsDir(s), id))),
    ...ids("ERASE_NATIVE_IDS").map((id) => join(nativeDir, id)),
  ];
  return dirs.length > 0 ? dirs : fail("ERASE_TENANT_IDS and ERASE_NATIVE_IDS are both empty");
};

switch (process.env.ERASE_MODE) {
  case "ids": {
    const secret = process.env.TC_MCP_STATE_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) fail("TC_MCP_STATE_SECRET is not set in this container");
    const hmac = (value) => createHmac("sha256", secret).update(value).digest("hex");
    if (list("ERASE_SUBJECTS").length + list("ERASE_DIDS").length === 0) fail("ERASE_SUBJECTS and ERASE_DIDS are both empty");
    for (const subject of list("ERASE_SUBJECTS")) console.log(`tenant ${hmac(`tenant:${subject}`)}`);
    for (const did of list("ERASE_DIDS")) console.log(`native ${hmac(`native-tenant:${canonical(did)}`)}`);
    break;
  }
  case "find": {
    const wanted = new Set(list("ERASE_ADDRESSES").map((a) => (ADDRESS.test(a) ? a.toLowerCase() : fail(`not a 0x address: ${a}`))));
    if (wanted.size === 0) fail("ERASE_ADDRESSES is empty");
    let scanned = 0;
    for (const surface of SURFACES) {
      for (const id of children(tenantsDir(surface))) {
        scanned++;
        const agent = join(tenantsDir(surface), id, ".tinycloud", "profiles", "agent");
        const owners = [readJson(join(agent, "profile.json"))?.ownerDid];
        const pending = join(agent, "pending");
        if (existsSync(pending)) {
          for (const file of readdirSync(pending)) {
            if (file.endsWith(".json")) owners.push(...[readJson(join(pending, file))?.ownerDids].flat());
          }
        }
        if (owners.some((did) => wanted.has(addressOf(did)))) console.log(`tenant ${id} (found on ${surface})`);
      }
    }
    for (const id of children(nativeDir)) {
      scanned++;
      const grant = readJson(join(nativeDir, id, ".tinycloud", "native-grant.json"));
      if (wanted.has(addressOf(grant?.ownerDid))) console.log(`native ${id}`);
    }
    console.log(`scanned ${scanned} tenant directories`);
    break;
  }
  case "plan":
  case "verify": {
    let present = 0;
    for (const dir of targets()) {
      if (existsSync(dir)) { present++; console.log(`PRESENT files=${countFiles(dir)} ${dir}`); }
      else console.log(`absent ${dir}`);
    }
    for (const surface of SURFACES) console.log(`count ${surface} tenants=${children(tenantsDir(surface)).length}`);
    console.log(`count native-tenants=${children(nativeDir).length}`);
    if (process.env.ERASE_MODE === "verify" && present > 0) fail(`${present} target directories still exist`);
    break;
  }
  case "delete": {
    if (process.env.ERASE_CONFIRM !== "delete") fail("set ERASE_CONFIRM=delete to delete");
    for (const dir of targets()) {
      if (!existsSync(dir)) { console.log(`absent ${dir}`); continue; }
      rmSync(dir, { recursive: true, force: true });
      console.log(`deleted ${dir}`);
    }
    break;
  }
  default:
    fail("set ERASE_MODE to ids, find, plan, delete or verify");
}
JS
C=$(docker ps --filter label=com.docker.compose.service=mcp --format '{{.Names}}')
echo "$C"   # exactly one name; stop if empty or more than one
erase() { docker exec -i -e ERASE_MODE="$1" -e ERASE_SUBJECTS -e ERASE_DIDS -e ERASE_ADDRESSES \
  -e ERASE_TENANT_IDS -e ERASE_NATIVE_IDS -e ERASE_CONFIRM "$C" node - < "$W/erase-account.cjs"; }
```

**Compute or find the ids.** Values are newline-separated. Set inputs with `export`, not as a prefix on the `erase` call: some shells (busybox `sh`) do not pass prefix assignments through a function. Then the helper sees no input and stops.

```bash
# Email path: ids from OpenKey's subjects and owner DIDs.
export ERASE_SUBJECTS='<sub 1>
<sub 2>' ERASE_DIDS='did:pkh:eip155:1:0x…'
erase ids

# Address path (and a cross-check on the email path): ids whose stored owner matches the address.
export ERASE_ADDRESSES='0x…'
erase find
```

`ids` prints `tenant <id>` per subject and `native <id>` per owner DID. `find` prints each matching `tenant <id>` with the surface it was found on, each matching `native <id>`, and how many directories it scanned. It reads other accounts' `profile.json`, `pending/*.json` and `native-grant.json` to compare owners, and prints nothing from them. Run `find` on the email path too, to catch subjects OpenKey did not list. Set `ERASE_TENANT_IDS` and `ERASE_NATIVE_IDS` to the union of the tenant ids and native ids from both commands.

## 4. Dry run, delete, read back

```bash
export ERASE_TENANT_IDS='<tenant id 1>
<tenant id 2>' ERASE_NATIVE_IDS='<native id>'
erase plan                              # each target: PRESENT files=N <path> | absent <path>; then per-root counts
export ERASE_CONFIRM=delete
erase delete                            # removes exactly those directories
unset ERASE_CONFIRM
erase verify                            # every target must print "absent"; exits 1 if any remain
```

- `plan` lists each tenant id under all five roots and each native id under `native-tenants/`, with a file count. Copy its output into the ticket.
- `delete` refuses to run without `ERASE_CONFIRM=delete`. It refuses any id that is not 64 lowercase hex characters, so it cannot be pointed at a parent directory. It removes only `<root>/tenants/<id>` and `native-tenants/<id>`.

**Read-back proof.** Paste the following into the ticket:
1. The `verify` output: every target `absent`, and each per-root count lower than in `plan` by exactly the number of targets deleted under that root.
2. A second `verify` at least `TC_MCP_APPROVAL_TTL_SECONDS` (900 s) later, which shows nothing was recreated.

If the second run shows a target `PRESENT`, a client is still authorised. Go back to step 2.

When the second `verify` passes, remove the helper with `rm -r -- "$W"`. Then the privacy contact replies to the requester.

## What not to touch

- `/var/lib/tinycloud-mcp/.tinycloud/native-service-key.json`. It is the connector's shared service identity for every native grant (`remote-store.ts:1558-1559`).
- Any other tenant directory, or the parent `tenants/` and `native-tenants/` directories. Never use globs, and never `rm` anything under `/var/lib/tinycloud-mcp` by hand.
- The `mcp-state` volume itself. Do not restart, redeploy or change the OS image to do this work.
- `TC_MCP_STATE_SECRET` and the other environment values. Do not print them. No `env`, `printenv` or `docker inspect` of the container config. Do not copy state files off the CVM, and do not `cat` them.
- Data outside this server, which this runbook does not erase:
  - the account's TinyCloud spaces on the node;
  - its OpenKey account;
  - TinyCloud One's own records.

  This runbook does not cover them.
- Logs. The Better Stack shipper sends only allowlisted event names and codes, with no subject, address or path (`docker-compose.phala.yml:63-66`). The local Docker log cache rotates at 3 × 10 MB (`:34-35`). Neither is touched here.

Unknowns to settle before the first live run:
- whether Phala keeps snapshots or backups of the `mcp-state` volume;
- whether OpenKey issues one subject per account, or one per OAuth client;
- whether the `phala ssh` shell on the dev image has the `docker` CLI and finds exactly one `mcp` container.

How it was tested: the helper and the session commands above were run under `dash` and busybox `sh` with Node 22. They ran against a synthetic state directory built with `RemoteTenantStore`, with `docker exec` stubbed to run Node locally. The helper's ids matched the ids the server's own code derives. It has not been run on the CVM.
