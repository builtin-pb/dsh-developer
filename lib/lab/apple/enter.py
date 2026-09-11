"""Join the root-owned workload cgroup before lowering credentials or executing."""
import os
import sys

with open('/sys/fs/cgroup/dsh-workload/cgroup.procs', 'w') as target:
    target.write(str(os.getpid()))
os.execv(sys.argv[1], sys.argv[1:])
