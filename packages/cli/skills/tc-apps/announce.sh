#!/bin/sh
# Owner message for one catalog app, chosen by this computer's approval state.
# Usage: sh announce.sh healthlog | sh announce.sh recipes
# Prints a STATE line for the agent, then the owner message as one fenced block between the BEGIN and END markers.
# AGENT_INSTALL_ENABLED must match TINY-APPS.md §3 (the INSTALL switch).
AGENT_INSTALL_ENABLED=false
DIR=${TC_APPS_STATE:-$HOME/.local/state/tc-apps}
case "$1" in
  healthlog) NAME='Health Log'; MARK=owner-approved; ACCESS="read it, add, change and delete its entries, save notes and preference files in it, and it can create, change and delete this app's tables" ;;
  recipes) NAME=Recipes; MARK=recipes-owner-approved; ACCESS='read it, add, change and delete its entries, save notes and preference files in it' ;;
  *) echo 'usage: sh announce.sh healthlog | recipes' >&2; exit 2 ;;
esac
if [ ! -f "$DIR/$MARK" ]; then KIND=FIRST; elif [ "$AGENT_INSTALL_ENABLED" = true ]; then KIND=APPROVED-ON; else KIND=APPROVED-OFF; fi
FOLDER=$(cd "$(dirname "$0")" && pwd)
GRANT_CMD="sh \"$FOLDER/owner-grant.sh\" $1"
ALLOW='# If your browser asks to connect to devices on your network, choose Allow.'
CANCEL="# If you cancel a screen or the terminal doesn't return, press Ctrl-C and tell me. If the page shows a code, paste it into this terminal."
echo "STATE: $KIND"
echo 'BEGIN OWNER MESSAGE'
echo '```text'
echo '# Verbatim: copy this message exactly as printed, character for character, once, in one code fence, and do not reword it. A reworded command, approval link or code can fail.'
case "$KIND" in
  FIRST) cat <<EOF
# TinyCloud is a place you control. Setup takes two steps: first you sign in to, or create, your OpenKey so I know who you are; then you give me permission to do what you asked.
# Run this in your own terminal. Approve each browser screen that opens; you may see one or two, one at a time.
# If you see two, the first is your own sign-in and doesn't give me access. The last one is the permission: it lets me work in your $NAME app for 7 days: $ACCESS.
$ALLOW
$CANCEL
$GRANT_CMD
EOF
  ;;
  APPROVED-OFF) cat <<EOF
# Run this in your own terminal. A browser approval screen will open: approve it.
# It lets me work in your $NAME app for 7 days: $ACCESS.
$ALLOW
$CANCEL
$GRANT_CMD
EOF
  ;;
  APPROVED-ON) cat <<EOF
# Run this in your own terminal. A browser approval screen will open: approve it. It installs this app's notes and tables in your TinyCloud, adds entries, and lets me work in your $NAME app for 7 days: $ACCESS.
$ALLOW
$CANCEL
$GRANT_CMD
EOF
  ;;
esac
echo '```'
echo 'END OWNER MESSAGE'
