#!/usr/bin/env python3
"""Runs a command under a seccomp filter that fails every connect(2) with
ECONNREFUSED without performing it, as a sandbox profile can. Unprivileged
(sets no_new_privs first). Usage: python3 refuse-connect.py <command> [args...]
Linux x86_64 and aarch64 only."""
import ctypes, errno, os, platform, struct, sys

ARCHES = {"x86_64": (0xC000003E, 42), "aarch64": (0xC00000B7, 203)}  # AUDIT_ARCH_*, __NR_connect
if platform.machine() not in ARCHES:
    sys.exit(f"refuse-connect: unsupported architecture {platform.machine()}")
AUDIT_ARCH, NR_CONNECT = ARCHES[platform.machine()]
BPF_LD_W_ABS, BPF_JEQ_K, BPF_RET_K = 0x20, 0x15, 0x06
RET_ALLOW, RET_ERRNO, RET_KILL_PROCESS = 0x7FFF0000, 0x00050000, 0x80000000
program = [
    (BPF_LD_W_ABS, 0, 0, 4),  # seccomp_data.arch
    (BPF_JEQ_K, 1, 0, AUDIT_ARCH),
    (BPF_RET_K, 0, 0, RET_KILL_PROCESS),
    (BPF_LD_W_ABS, 0, 0, 0),  # seccomp_data.nr
    (BPF_JEQ_K, 0, 1, NR_CONNECT),
    (BPF_RET_K, 0, 0, RET_ERRNO | errno.ECONNREFUSED),
    (BPF_RET_K, 0, 0, RET_ALLOW),
]
filters = ctypes.create_string_buffer(b"".join(struct.pack("HBBI", *instruction) for instruction in program))


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]


libc = ctypes.CDLL(None, use_errno=True)
PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 38, 22, 2
prog = SockFprog(len(program), ctypes.cast(filters, ctypes.c_void_p))
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) or libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(prog)):
    sys.exit(f"refuse-connect: {os.strerror(ctypes.get_errno())}")
os.execvp(sys.argv[1], sys.argv[1:])
