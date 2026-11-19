"""Run a command as the foreground job of a new pseudo-terminal and type
Ctrl-C once its output contains a marker.

Usage: pty-interrupt.py MARKER COMMAND [ARGS...]. The command leads a new
session whose controlling terminal is the pseudo-terminal, so Ctrl-C reaches
its whole foreground process group, as it does at a shell. Prints one JSON
object: {"exit": int|null, "signal": int|null, "output": str}. Gives up
after 30 s so a regression fails rather than hangs.
"""
import json
import os
import pty
import signal
import sys

marker = sys.argv[1].encode()
signal.alarm(30)
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
output = b""
typed = False
while True:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    if not typed and marker in output:
        os.write(master, b"\x03")
        typed = True
_, status = os.waitpid(pid, 0)
print(json.dumps({
    "exit": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
    "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
    "output": output.decode("utf-8", "replace"),
}))
