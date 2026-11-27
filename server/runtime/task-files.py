"""Transfer a regular file between Pi's private staging area and a task directory."""
import hashlib
import os
import secrets
import shutil
import stat
import sys

LIMIT = 32 * 1024 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

def copy_checked(directory, name, dest=None):
    try:
        file = os.open(name, READ, dir_fd=directory)
    except FileNotFoundError:
        return "missing"
    with os.fdopen(file, "rb") as source:
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            raise ValueError("需要 32 MB 以内的普通任务文件")
        digest = hashlib.sha256()
        size = 0
        while chunk := source.read(65536):
            size += len(chunk)
            if size > LIMIT:
                raise ValueError("文件过大")
            digest.update(chunk)
            if dest:
                dest.write(chunk)
        return digest.hexdigest()

def transfer(action, root, relative, stage, expected=None):
    parts = relative.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("需要任务内的相对路径")
    directory = os.open(root, DIR)
    try:
        for part in parts[:-1]:
            if action == "commit":
                try:
                    os.mkdir(part, 0o700, dir_fd=directory)
                except FileExistsError:
                    pass
            try:
                child = os.open(part, DIR, dir_fd=directory)
            except FileNotFoundError:
                if action == "snapshot":
                    return "missing"
                raise
            os.close(directory)
            directory = child
        name = parts[-1]
        if action == "snapshot":
            with open(stage, "wb") as dest:
                result = copy_checked(directory, name, dest)
            if result == "missing":
                os.unlink(stage)
            return result
        if expected != copy_checked(directory, name):
            raise ValueError("文件已被其他操作修改，请重新读取")
        tmp = ".pi-" + secrets.token_hex(12)
        out = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=directory)
        try:
            with os.fdopen(out, "wb") as dest, open(stage, "rb") as src:
                if expected != "missing":
                    mode = os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode
                    os.fchmod(dest.fileno(), mode & 0o777)
                shutil.copyfileobj(src, dest)
            os.replace(tmp, name, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try:
                os.unlink(tmp, dir_fd=directory)
            except FileNotFoundError:
                pass
    finally:
        os.close(directory)

try:
    print(transfer(*sys.argv[1:]) or "ok")
except (ValueError, OSError) as error:
    sys.exit(str(error))
