"""Freeze and kill the entire workload cgroup; forks cannot escape membership."""
import json
import os
import signal
import time

root = '/sys/fs/cgroup/dsh-workload/'

def write(name, value):
    with open(root + name, 'w') as target:
        target.write(value)

def wait_event(name, value):
    for attempt in range(200):
        events = dict(row.split() for row in open(root + 'cgroup.events'))
        if events.get(name) == value:
            return
        time.sleep(0.01)
    raise RuntimeError('Workload cgroup did not reach ' + name + '=' + value)

write('cgroup.freeze', '1')
wait_event('frozen', '1')
found = sorted(set(int(row) for row in open(root + 'cgroup.threads')))
# The guest kernel's cgroup.kill can skip a zombie group leader even when
# its threads remain alive. Membership is frozen, so signal every represented
# thread group as well; no workload can fork between enumeration and kill.
handles = {}
try:
    # Pin all groups before sending signals. A disappearing task must never
    # turn PID reuse into authority over a trusted control process.
    for tid in found:
        descriptor = None
        try:
            fields = dict(row.split(':', 1) for row in open('/proc/' + str(tid) + '/status') if ':' in row)
            tgid = int(fields['Tgid'])
            if tgid in handles:
                continue
            descriptor = os.pidfd_open(tgid)
            membership = open('/proc/' + str(tgid) + '/cgroup').read().strip()
            if membership != '0::/dsh-workload':
                raise RuntimeError('Workload process membership changed while pinning')
            handles[tgid] = descriptor
            descriptor = None
        except (FileNotFoundError, ProcessLookupError):
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
    for descriptor in handles.values():
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        except ProcessLookupError:
            pass
finally:
    for descriptor in handles.values():
        os.close(descriptor)
write('cgroup.kill', '1')
# Let killed frozen tasks complete exit, including zombie thread leaders.
write('cgroup.freeze', '0')
wait_event('populated', '0')
print(json.dumps(dict(found=found, killed=found, remaining=[], freezeVerified=True, populated=False)))
