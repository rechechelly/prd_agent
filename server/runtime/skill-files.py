"""Read the workspace's shell-writable skill directory without following links."""
import base64
from contextlib import contextmanager
import json
import os
import stat
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
LIMIT = 36 * 1024 * 1024  # The upload API accepts up to 50 MB of base64 JSON.

@contextmanager
def regular_file(directory, name, limit):
    with os.fdopen(os.open(name, REGULAR, dir_fd=directory), "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("技能资源需要为独立的普通文件")
        if info.st_size > limit:
            raise ValueError("技能包超出容量限制")
        yield f

def read_file(directory, name, limit):
    with regular_file(directory, name, limit) as f:
        value = f.read(limit + 1)
        if len(value) > limit:
            raise ValueError("技能包超出容量限制")
        return value

def frontmatter(directory):
    with regular_file(directory, "SKILL.md", LIMIT) as f:
        lines = bytearray(f.readline(LIMIT + 1))
        if lines.decode("utf-8-sig").rstrip() != "---":
            return ""
        while len(lines) < LIMIT:
            line = f.readline(LIMIT - len(lines) + 1)
            if not line: break
            lines.extend(line)
            if line.rstrip() == b"---":
                return lines.decode("utf-8-sig")
        return ""

def package(directory):
    files = []
    remaining = LIMIT
    def visit(current, prefix):
        nonlocal remaining
        for item in sorted(os.listdir(current)):
            if item.startswith(".") or item == "node_modules": continue
            mode = os.stat(item, dir_fd=current, follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode):
                child = os.open(item, DIRECTORY, dir_fd=current)
                try: visit(child, prefix + item + "/")
                finally: os.close(child)
            elif stat.S_ISREG(mode):
                data = read_file(current, item, remaining)
                remaining -= len(data)
                files.append({"path": prefix + item, "data": base64.b64encode(data).decode("ascii")})
    visit(directory, "")
    return files

def read(root, operation, name=None):
    directory = os.open(root, DIRECTORY)
    try:
        if operation == "index":
            entries = []
            for item in sorted(os.listdir(directory)):
                if item.startswith("."): continue
                if not stat.S_ISDIR(os.stat(item, dir_fd=directory, follow_symlinks=False).st_mode): continue
                try:
                    child = os.open(item, DIRECTORY, dir_fd=directory)
                    try: header = frontmatter(child)
                    finally: os.close(child)
                    entries.append({"name": item, "text": header})
                except FileNotFoundError: continue  # Incomplete or concurrently removed package.
                except (ValueError, OSError) as error: entries.append({"name": item, "error": str(error)})
            return entries
        if operation not in ("entry", "package") or not name or "/" in name or name.startswith("."):
            raise ValueError("技能名称无效")
        child = os.open(name, DIRECTORY, dir_fd=directory)
        try:
            if operation == "entry":
                return read_file(child, "SKILL.md", LIMIT).decode("utf-8-sig")
            return package(child)
        finally: os.close(child)
    finally: os.close(directory)

try:
    json.dump(read(*sys.argv[1:]), sys.stdout, ensure_ascii=False)
except (ValueError, OSError) as error:
    sys.exit(str(error))
