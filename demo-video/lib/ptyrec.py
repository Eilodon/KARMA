#!/usr/bin/env python3
"""Run a child command under a PTY of a fixed size, streaming its output.

asciinema needs a real terminal and sizes the recorded session to its own tty.
Our orchestrator runs without a tty, so we give asciinema a PTY at REC_COLS x REC_ROWS
(default 110x32) — wide enough that Pharosscan tx URLs never wrap in the recording.

    REC_COLS=110 REC_ROWS=32 python3 ptyrec.py <cmd> [args...]

Exit code is the child's exit code.
"""
import os
import sys
import pty
import select
import struct
import fcntl
import termios

cols = int(os.environ.get("REC_COLS", "110"))
rows = int(os.environ.get("REC_ROWS", "32"))
argv = sys.argv[1:]
if not argv:
    sys.stderr.write("ptyrec: no command\n")
    sys.exit(2)

pid, fd = pty.fork()
if pid == 0:  # child
    os.execvp(argv[0], argv)
    os._exit(127)

# parent: force the window size, then pump the child's output to our stdout
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
try:
    while True:
        try:
            r, _, _ = select.select([fd], [], [])
        except (OSError, select.error):
            break
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
finally:
    pass

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
