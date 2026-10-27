#!/bin/sh
# Owner step: copy one generic tiny app's records from the old `default` space into the app's own root in
# `applications`. Run it in your own terminal, not in an agent's shell.
#   sh migrate.sh --dry-run [<app>]                       print what would be copied; nothing is written
#   sh migrate.sh [--source-profile <name>] <app>         copy, read back, compare, re-check the old place, then record the move
# The old place is only read: this script has no delete and no write to it. Every write to the new place creates a key
# that does not exist yet. Any mismatch, collision, refusal or error prints NOT SWITCHED and stops; the old records stay
# as they are. Running it again after fixing the cause is safe: keys that already hold the same content are recognised.
# `--source-profile default` reads the old place with your own sign-in, not the agent's `agent-data` profile.
set -u
umask 077
usage() { echo 'usage: sh migrate.sh --dry-run [<app>] | sh migrate.sh [--source-profile <name>] <app>' >&2; exit 2; }
DRY=0; SRC=agent-data; SLUG=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --source-profile) [ $# -ge 2 ] || usage; SRC=$2; shift ;;
    -*) usage ;;
    *) [ -z "$SLUG" ] || usage; SLUG=$1 ;;
  esac
  shift
done
[ -n "$SLUG" ] || [ "$DRY" -eq 1 ] || usage
case "$SRC" in ''|*[!A-Za-z0-9._-]*) usage ;; esac
if [ -n "$SLUG" ]; then
  case "$SLUG" in [a-z]*) ;; *) usage ;; esac
  case "$SLUG" in *[!a-z0-9-]*) usage ;; esac
  case "$SLUG" in catalog|index-stale|healthlog|recipes) echo "'$SLUG' is a reserved name and cannot be a generic app." >&2; exit 2 ;; esac
fi
command -v jq > /dev/null 2>&1 || { echo 'jq is needed. Install it, then run this again.' >&2; exit 3; }
if command -v sha256sum > /dev/null 2>&1; then sha() { sha256sum | cut -d' ' -f1; }; else sha() { shasum -a 256 | cut -d' ' -f1; }; fi
# The copy needs the create-only write of CLI 1.5.0-beta.2, which the setup installs in its own folder.
TC_BIN=${TC_BETA_BIN:-$HOME/.local/share/tc-apps/cli-beta/node_modules/.bin/tinycloud}
STATE=${TC_APPS_STATE:-$HOME/.local/state/tc-apps}
R=xyz.tinycloud.agent-data
TAB=$(printf '\t')
tc() { "$TC_BIN" "$@" < /dev/null; }
refuse() {
  echo "NOT SWITCHED: $1" >&2
  echo 'The old records were not changed or deleted. Tell your agent what this said.' >&2
  exit 1
}
# list <profile> <space> <prefix>: every key under the prefix, sorted, one per line. Fails if the listing is incomplete.
list() {
  _o=$(tc kv list --prefix "$3" --space "$2" --all --json --profile "$1") || return 1
  _k=$(printf '%s\n' "$_o" | jq -r '.keys[]') || return 1
  [ -z "$_k" ] || printf '%s\n' "$_k" | LC_ALL=C sort
}

if [ -z "$SLUG" ]; then
  CAT=$(list "$SRC" default "$R/catalog/") || { echo "Could not list the old catalog with profile $SRC." >&2; exit 1; }
  printf '%s\n' "$CAT" | sed -n "s|^$R/catalog/\([^/][^/]*\)\$|app: \1|p"
  echo 'Dry run: nothing was written. Run again with one app name for its plan.'
  exit 0
fi

ID=xyz.tinycloud.tinyapps.$SLUG
DEST=tinyapp-$SLUG
# The old keys of this app: its catalog records, then its data. Fails if a listing is incomplete.
inventory() {
  _c=$(list "$SRC" default "$R/catalog/") || return 1
  _d=$(list "$SRC" default "$R/$SLUG/") || return 1
  printf '%s\n' "$_c" | awk -v a="$R/catalog/$SLUG" '$0 == a || index($0, a "/") == 1'
  printf '%s\n' "$_d" | awk 'NF'
}
dest_key() {
  case "$1" in
    "$R/catalog/$SLUG") printf '%s\n' "$ID/catalog" ;;
    "$R/catalog/$SLUG/"*) printf '%s\n' "$ID/catalog/${1#"$R/catalog/$SLUG/"}" ;;
    *) printf '%s\n' "$ID/${1#"$R/$SLUG/"}" ;;
  esac
}
fsha() { sha < "$1"; }
csha() { { jq -cS . "$1" 2> /dev/null || cat "$1"; } | sha; }
REENC=0
# same <file> <file>: identical bytes, or the same JSON written differently (counted).
same() {
  [ "$(fsha "$1")" = "$(fsha "$2")" ] && return 0
  [ "$(csha "$1")" = "$(csha "$2")" ] && { REENC=$((REENC + 1)); return 0; }
  return 1
}

KEYS=$(inventory) || { echo "Could not list the old records with profile $SRC. Check the sign-in, then run this again." >&2; exit 1; }
if [ -z "$KEYS" ]; then
  echo "Nothing to migrate: there are no old records for '$SLUG'. Nothing was written."
  exit 0
fi
case "$KEYS" in *"$TAB"*) refuse 'a key contains a tab; nothing was changed.' ;; esac
while IFS= read -r k; do
  case "$k" in
    "$R/catalog/$SLUG" | "$R/catalog/$SLUG/"*) ;;
    *) case "${k#"$R/$SLUG/"}" in catalog | catalog/* | index-stale | index-stale/*) refuse "the old record $k has a kind named catalog or index-stale, which the new layout reserves. Nothing was copied." ;; esac ;;
  esac
done <<EOF
$KEYS
EOF
TOTAL=$(printf '%s\n' "$KEYS" | wc -l | tr -d ' ')
NCAT=$(printf '%s\n' "$KEYS" | grep -c "^$R/catalog/")
tc kv list --prefix "$ID/" --space applications --json --profile "$DEST" > /dev/null 2>&1 && READY=1 || READY=0

echo "App: $SLUG -> $ID (profile $DEST, space applications)"
echo "Old place: $R/ in space default, profile $SRC, read only"
echo "Records to copy: $TOTAL records ($NCAT catalog, $((TOTAL - NCAT)) data)"
printf '%s\n' "$KEYS" | grep -v "^$R/catalog/" | sed "s|^$R/$SLUG/||" | cut -d/ -f1 | sort | uniq -c | sed 's/^ *\([0-9]*\) \(.*\)$/  kind \2: \1/'
if [ "$READY" -eq 1 ]; then echo "Approval for the new place: ready"; else echo "Approval for the new place: missing"; fi
if [ "$DRY" -eq 1 ]; then
  [ "$READY" -eq 1 ] || echo "Ask your agent to request the approval for '$SLUG' first; the copy needs it."
  echo 'Dry run: nothing was written.'
  exit 0
fi
[ "$READY" -eq 1 ] || refuse "this computer has no approval for '$SLUG' in the new place yet (profile $DEST). Ask your agent to request the approval, then run this again."

WORK=$STATE/migration/$SLUG.work
mkdir -p "$WORK/src" "$WORK/dst" || refuse "could not create $WORK"
: > "$WORK/map.tsv"

# 1. Inventory: save every old record to a private local folder.
while IFS= read -r k; do
  h=$(printf '%s' "$k" | sha)
  tc kv get "$k" --raw --space default --profile "$SRC" > "$WORK/src/$h" || refuse "could not read $k from the old place."
  printf '%s\t%s\t%s\n' "$k" "$(dest_key "$k")" "$h" >> "$WORK/map.tsv"
done <<EOF
$KEYS
EOF

# put_new <key> <file>: create the key in the new place. 0 created, 1 the key already exists, 2 refused or failed.
put_new() {
  _e=$(tc kv put "$1" --space applications --if-none-match '*' --file "$2" --json --profile "$DEST" 2>&1 > /dev/null); _rc=$?
  [ "$_rc" -eq 0 ] && return 0
  case "$_e" in *KV_ALREADY_EXISTS*) return 1 ;; esac
  printf '%s\n' "$_e" >&2
  return 2
}

# 2. Copy: catalog first, then the records. A key that already exists must hold the same content.
while IFS="$TAB" read -r s d h; do
  put_new "$d" "$WORK/src/$h"; rc=$?
  if [ "$rc" -eq 1 ]; then
    tc kv get "$d" --raw --space applications --profile "$DEST" > "$WORK/dst/$h" || refuse "could not read the existing $d."
    same "$WORK/src/$h" "$WORK/dst/$h" || refuse "$d already exists in the new place with different content. Nothing was overwritten."
  elif [ "$rc" -ne 0 ]; then
    refuse "could not write $d."
  fi
done < "$WORK/map.tsv"

# 3. Read back: the same keys, and the same content under each.
cut -f2 "$WORK/map.tsv" | LC_ALL=C sort > "$WORK/expect.txt"
list "$DEST" applications "$ID/" > "$WORK/found.txt" || refuse "could not list the new place."
if ! cmp -s "$WORK/expect.txt" "$WORK/found.txt"; then
  echo 'Keys only in the old copy plan (<) or only in the new place (>):' >&2
  diff "$WORK/expect.txt" "$WORK/found.txt" | grep '^[<>]' >&2
  refuse 'the new place and the old place do not hold the same keys.'
fi
REENC=0
while IFS="$TAB" read -r s d h; do
  tc kv get "$d" --raw --space applications --profile "$DEST" > "$WORK/dst/$h" || refuse "could not read $d back from the new place."
  same "$WORK/src/$h" "$WORK/dst/$h" || refuse "$d reads back different from the old record."
done < "$WORK/map.tsv"
READBACK_REENC=$REENC

# 4. Re-check the old place for edits made while copying.
KEYS2=$(inventory) || refuse 'could not list the old place again.'
[ "$KEYS2" = "$KEYS" ] || refuse 'the old place gained or lost records while copying. Pause every device that writes this app, then run this again.'
while IFS="$TAB" read -r s d h; do
  tc kv get "$s" --raw --space default --profile "$SRC" > "$WORK/again" || refuse "could not read $s again."
  [ "$(fsha "$WORK/again")" = "$(fsha "$WORK/src/$h")" ] || refuse "$s changed in the old place while copying. Pause every device that writes this app, then run this again."
done < "$WORK/map.tsv"

# 5. Record the move: the discovery entry other devices read, then the local receipt.
CATH=$(awk -F "$TAB" -v k="$R/catalog/$SLUG" '$1 == k { print $3 }' "$WORK/map.tsv")
TITLE=
[ -z "$CATH" ] || TITLE=$(jq -r '.title // empty' "$WORK/src/$CATH" 2> /dev/null)
[ -n "$TITLE" ] || TITLE=$SLUG
jq -cn --arg app "$SLUG" --arg id "$ID" --arg title "$TITLE" '{v: 1, app: $app, id: $id, title: $title}' > "$WORK/entry.json" || refuse 'could not build the discovery entry.'
put_new "xyz.tinycloud.tinyapps.catalog/$SLUG/entry" "$WORK/entry.json"; rc=$?
if [ "$rc" -eq 1 ]; then
  tc kv get "xyz.tinycloud.tinyapps.catalog/$SLUG/entry" --raw --space applications --profile "$DEST" > "$WORK/entry.found" || refuse 'could not read the existing discovery entry.'
  same "$WORK/entry.json" "$WORK/entry.found" || refuse "the discovery entry for '$SLUG' already exists with different content."
elif [ "$rc" -ne 0 ]; then
  refuse 'could not write the discovery entry.'
fi
DIGEST=$(while IFS="$TAB" read -r s d h; do printf '%s\t%s\n' "$d" "$(fsha "$WORK/src/$h")"; done < "$WORK/map.tsv" | LC_ALL=C sort | sha)
RECEIPT=$STATE/migration/$SLUG.receipt.json
jq -n --arg app "$SLUG" --arg id "$ID" --arg at "$(date -u +%FT%TZ)" --arg root "$R" --arg profile "$SRC" --arg digest "$DIGEST" \
  --argjson total "$TOTAL" --argjson catalog "$NCAT" --argjson reencoded "$READBACK_REENC" \
  '{v: 1, app: $app, id: $id, verified: true, at: $at, source: {space: "default", root: $root, profile: $profile}, counts: {catalog: $catalog, records: ($total - $catalog), total: $total, reencoded: $reencoded}, digest: $digest, old_records: "kept"}' \
  > "$RECEIPT.tmp" && mv -f "$RECEIPT.tmp" "$RECEIPT" || refuse 'could not write the receipt.'
echo "Moved and verified: $TOTAL records for '$SLUG' are in $ID/ in your applications space, and they read back the same."
echo 'The old records in your default space were left as they are. Nothing was deleted.'
case "$WORK" in "$STATE"/migration/*.work) rm -rf "$WORK" ;; esac
echo 'The private working copy of the old records was removed; a refused run keeps it for diagnosis.'
echo "Receipt: $RECEIPT"
echo 'Tell your agent.'
