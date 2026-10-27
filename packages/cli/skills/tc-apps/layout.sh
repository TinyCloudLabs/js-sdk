#!/bin/sh
# Prints which layout a generic tiny app uses on this computer, then exits 0. It only reads.
#   new          a verified move exists here (migration receipt), or the old place holds no records for the app
#   legacy       the old place (`default`, xyz.tinycloud.agent-data/) holds records for the app and no verified move exists
#   ask          the old place can't be listed with this computer's earlier sign-in (none, or expired): ask the owner
#   check-failed the listing failed for another reason (for example the network): write nothing, try again later
# Exit codes: 0 after printing one word, 2 for a bad app name, 3 when jq is missing (nothing is printed; install jq).
# Usage: sh layout.sh <app>
# It runs no sign-in and creates no profile or grant. A receipt counts only when it says "verified": true for this app.
set -u
slug=${1:-}
case "$slug" in [a-z]*) ;; *) echo 'usage: sh layout.sh <app>' >&2; exit 2 ;; esac
case "$slug" in *[!a-z0-9-]*) echo 'usage: sh layout.sh <app>' >&2; exit 2 ;; esac
case "$slug" in catalog|index-stale|healthlog|recipes) echo "'$slug' is a reserved name and cannot be a generic app." >&2; exit 2 ;; esac
command -v jq > /dev/null 2>&1 || { echo 'jq is needed. Install it, then run this again.' >&2; exit 3; }
if [ -z "${TC_BIN:-}" ]; then W=$HOME/.local/share/tc-apps; TC_BIN=$W/tinycloud; [ -x "$TC_BIN" ] || TC_BIN=$W/tc; fi
STATE=${TC_APPS_STATE:-$HOME/.local/state/tc-apps}
R=xyz.tinycloud.agent-data
if jq -e --arg a "$slug" '.verified == true and .app == $a' "$STATE/migration/$slug.receipt.json" > /dev/null 2>&1; then
  echo new
  exit 0
fi
OUT=$("$TC_BIN" kv list --prefix "$R/catalog/" --space default --all --json --profile agent-data < /dev/null 2>&1); RC=$?
if [ "$RC" -eq 0 ]; then
  if printf '%s\n' "$OUT" | jq -e --arg k "$R/catalog/$slug" '.keys | map(. == $k) | any' > /dev/null 2>&1; then echo legacy; else echo new; fi
  exit 0
fi
case "$OUT" in
  *PROFILE_NOT_FOUND* | *AUTH_REQUIRED* | *AUTH_EXPIRED* | *AUTH_UNAUTHORIZED* | *PERMISSION_DENIED* | *"SIWE is expired"*) echo ask ;;
  *) echo check-failed ;;
esac
exit 0
