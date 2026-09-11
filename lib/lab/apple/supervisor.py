"""Trusted PID 1: the workload cannot modify its root-only lease or policy."""
import os
import signal
import subprocess
import time

subprocess.run(['/usr/bin/mount', '-o', 'remount,size=8M,nr_inodes=2048', '/opt/workspace'], check=True)
subprocess.run(['/usr/bin/mount', '-o', 'remount,size=8M,nr_inodes=2048', '/tmp'], check=True)
# No delegation: unprivileged workloads cannot leave or reconfigure this group.
os.mkdir('/sys/fs/cgroup/dsh-workload', 0o700)
os.mkdir('/tmp/home', 0o777)
os.chmod('/tmp/home', 0o777)
lease = '/run/dsh/lease'
with open(lease, 'x'):
    pass
with open('/run/dsh/ready', 'x'):
    pass
# PID 1 exiting stops the container VM, including escaped process groups.
started = time.monotonic()
while time.monotonic() - started < 900:
    if time.time() - os.stat(lease).st_mtime > 6:
        break
    try:
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass
    except ChildProcessError:
        pass
    time.sleep(0.1)
