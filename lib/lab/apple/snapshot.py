"""Export a bounded ordinary tree after all workload processes are gone."""
import io
import os
import stat
import sys
import tarfile

root = '/opt/workspace'
files = []
pending = [root]
total = 0
entries = 0
while pending:
    directory = pending.pop()
    for item in os.scandir(directory):
        info = item.stat(follow_symlinks=False)
        entries += 1
        if entries > 1024:
            raise ValueError('too many tree entries')
        if stat.S_ISDIR(info.st_mode):
            pending.append(item.path)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            total += info.st_size
            if info.st_size > 524288 or total > 4194304 or len(files) >= 256:
                raise ValueError('tree exceeds transfer bounds')
            files.append(item.path)
        else:
            raise ValueError('non-ordinary result')
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
    for path in sorted(files):
        data = open(path, 'rb').read(524289)
        data.decode('utf-8', errors='strict')
        if len(data) > 524288 or b'\0' in data:
            raise ValueError('non-text result')
        entry = tarfile.TarInfo(os.path.relpath(path, root))
        entry.size = len(data)
        entry.mode = 0o600
        archive.addfile(entry, io.BytesIO(data))
