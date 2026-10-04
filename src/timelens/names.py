#!/usr/bin/env python3
"""
The names of processes and threads, from the metadata events of the log files.

A metadata event ('ph': 'M', 'cat': '__metadata') is not an event of the program. 'process_name' gives the
pid a name and 'thread_name' gives a tid a name, in 'args.name':

    { "args": {"name": "pylon_gevmgr"}, "name": "process_name", "cat": "__metadata", "ph": "M", "pid": 1028534, "tid": 0, "ts": 0 }
"""

from __future__ import annotations

PROCESS = "process"
THREAD = "thread"


def is_metadata(evt):
    return evt.get("ph") == "M" or evt.get("cat") == "__metadata"


class Names:
    def __init__(self):
        self.processes = {}     # pid -> name
        self.threads = {}       # (pid, tid) -> name

    # Takes the name of a 'process_name' or 'thread_name' event. Returns (kind, pid, tid, name) when that is a
    # new or changed name, otherwise None: also for the other kinds of metadata, like 'process_sort_index'.
    def add(self, evt):
        kind = {"process_name": PROCESS, "thread_name": THREAD}.get(evt.get("name"))
        args = evt.get("args")
        name = args.get("name") if isinstance(args, dict) else None
        if kind is None or not isinstance(name, str) or not name:
            return None

        pid, tid = evt.get("pid"), evt.get("tid")
        if kind == PROCESS:
            if self.processes.get(pid) == name:
                return None
            self.processes[pid] = name
            return PROCESS, pid, None, name

        if self.threads.get((pid, tid)) == name:
            return None
        self.threads[(pid, tid)] = name
        return THREAD, pid, tid, name

    # all names, as sent to a client that connects
    def snapshot(self):
        return {
            "type": "names",
            "processes": [[pid, name] for pid, name in self.processes.items()],
            "threads": [[pid, tid, name] for (pid, tid), name in self.threads.items()],
        }

    # the message for a name that was added, see 'add()'
    @staticmethod
    def message(change):
        kind, pid, tid, name = change
        return {"type": "name", "kind": kind, "pid": pid, "tid": tid, "name": name}
