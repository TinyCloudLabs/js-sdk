"""Run a command with stdout on a pseudo-terminal and stderr on a pipe.

Prints one JSON object: {"exit": int, "stdout": str, "stderr": str}. Tests use
it to exercise the CLI as a person at a terminal sees it, while still reading
stderr separately.
"""
import json
import os
import pty
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
stdout = b""
while True:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    stdout += chunk
stderr = child.stderr.read()
code = child.wait()
print(json.dumps({
    "exit": code,
    "stdout": stdout.decode("utf-8", "replace"),
    "stderr": stderr.decode("utf-8", "replace"),
}))
