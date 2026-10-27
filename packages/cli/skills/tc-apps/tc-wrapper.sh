#!/bin/sh
# tc-apps: runs the TinyCloud CLI named in cli-path, next to this script. A kv or sql command that fails with
# NETWORK_ERROR (a dropped connection, "fetch failed") runs again, up to twice, after 2 s and 4 s; only the last
# attempt's error is shown. The setup at agents.tinycloud.xyz/apps copies this file to ~/.local/share/tc-apps/tinycloud.
CLI=$(cat "$(dirname "$0")/cli-path")
case "$1" in kv|sql) ;; *) exec "$CLI" "$@" ;; esac
case " $* " in *" --stdin "*) IN=$(cat) ;; *) IN= ;; esac
exec 3>&1
for n in 1 2 3; do
  E=$(printf '%s\n' "$IN" | "$CLI" "$@" 2>&1 >&3 3>&-); c=$?
  [ $c -ne 0 ] && [ $n -lt 3 ] && case "$E" in *NETWORK_ERROR*) sleep $((n * 2)); continue ;; esac
  break
done
[ -z "$E" ] || printf '%s\n' "$E" >&2
exit $c
