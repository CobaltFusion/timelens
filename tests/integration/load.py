"""
Writes '*.vson' log files for the integration tests: a simulated vision pipeline that logs live, like a real program.

A camera grabs a frame every 'frame_us', three workers take turns to process the frames ('process_image', with
'detect_edges' and 'classify' inside it), an io thread serializes and sends the results, and a PLC is polled every
10 ms. Every 'flush_every_frames' frames the logger flushes to disk, and the worker of that frame waits for it.
'process_image' is written as a begin and an end line, the other events as complete events ('X').
"""

from __future__ import annotations

import json
import random
import threading
import time
from pathlib import Path

CAMERA, INSPECTOR, PLC = 4100, 4200, 4300
GRAB, IO, LOGGER, POLL = 4101, 4220, 4230, 4301
WORKERS = (4211, 4212, 4213)

# the rows of the graph: one per thread
THREADS = (GRAB, *WORKERS, IO, LOGGER, POLL)


def now_us():
    return int(time.time() * 1_000_000)


def line(event):
    return json.dumps(event) + ",\n"


def metadata(pid, tid, kind, name):
    return line({"args": {"name": name}, "name": kind, "cat": "__metadata", "ph": "M", "pid": pid, "tid": tid, "ts": 0})


class LiveLog:
    """Writes the pipeline to 'folder' in a thread, in real time, until 'stop()'. Lines are written when their time has come."""

    def __init__(self, folder: Path, frame_us=33_333, flush_every_frames=90, poll_us=10_000, seed=3):
        self.folder = Path(folder)
        self.frame_us = frame_us
        self.flush_every_frames = flush_every_frames
        self.poll_us = poll_us
        self.random = random.Random(seed)
        self.files = {}
        self.pending = []           # (time to write it, file, event)
        self.frames = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _file(self, name):
        if name not in self.files:
            self.files[name] = (self.folder / f"telemetry_{name}.vson").open("a", encoding="utf8", newline="\n", buffering=1)
        return self.files[name]

    def _complete(self, file, pid, tid, name, ts, dur):
        self.pending.append((ts + dur, file, {"name": name, "ph": "X", "pid": pid, "tid": tid, "ts": int(ts), "dur": int(dur)}))

    def _begin_end(self, file, pid, tid, name, ts, dur):
        self.pending.append((ts, file, {"name": name, "ph": "B", "pid": pid, "tid": tid, "ts": int(ts)}))
        self.pending.append((ts + dur, file, {"name": name, "ph": "E", "pid": pid, "tid": tid, "ts": int(ts + dur)}))

    def start(self):
        self._file("camera").write(metadata(CAMERA, 0, "process_name", "camera_service") + metadata(CAMERA, GRAB, "thread_name", "grab"))
        inspector = self._file("inspector")
        inspector.write(metadata(INSPECTOR, 0, "process_name", "inspector"))
        for number, tid in enumerate(WORKERS, 1):
            inspector.write(metadata(INSPECTOR, tid, "thread_name", f"worker {number}"))
        inspector.write(metadata(INSPECTOR, IO, "thread_name", "io") + metadata(INSPECTOR, LOGGER, "thread_name", "logger"))
        self._file("plc").write(metadata(PLC, 0, "process_name", "plc_bridge") + metadata(PLC, POLL, "thread_name", "poll"))
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        self._thread.join(5)
        for f in self.files.values():
            f.close()

    def _frame(self, t, io_free):
        r = self.random
        grab = r.uniform(2200, 2900)
        self._complete("camera", CAMERA, GRAB, "grab_frame", t, grab)
        start = t + grab + r.uniform(150, 400)
        worker = WORKERS[self.frames % len(WORKERS)]
        slow = 0
        if self.flush_every_frames and self.frames % self.flush_every_frames == self.flush_every_frames - 1:
            self._complete("inspector", INSPECTOR, LOGGER, "flush_log", t - 4000, r.uniform(34000, 40000))
            slow = r.uniform(26000, 34000)
        edges = r.uniform(4000, 6000) + slow
        classify = r.uniform(6500, 9000)
        self._begin_end("inspector", INSPECTOR, worker, "process_image", start, edges + classify + 300)
        self._complete("inspector", INSPECTOR, worker, "detect_edges", start + 100, edges)
        self._complete("inspector", INSPECTOR, worker, "classify", start + 200 + edges, classify)
        done = max(start + edges + classify + 300, io_free) + r.uniform(80, 200)
        serialize = r.uniform(600, 900)
        send = r.uniform(1500, 3000)
        self._complete("inspector", INSPECTOR, IO, "serialize", done, serialize)
        self._complete("inspector", INSPECTOR, IO, "send_result", done + serialize + 60, send)
        self.frames += 1
        return done + serialize + 60 + send

    def _run(self):
        t = now_us() + 20_000
        io_free = t
        next_poll = t
        while not self._stop.is_set():
            # the events of the frames up to 40 ms ahead are known, they are written when their time has come
            while t - now_us() < 40_000:
                io_free = self._frame(t, io_free)
                while self.poll_us and next_poll < t + self.frame_us:
                    self._complete("plc", PLC, POLL, "poll_plc", next_poll, self.random.uniform(150, 350))
                    next_poll += self.poll_us
                t += self.frame_us
            self.pending.sort(key=lambda p: p[0])
            current = now_us()
            written = 0
            while written < len(self.pending) and self.pending[written][0] <= current:
                _, file, event = self.pending[written]
                self._file(file).write(line(event))
                written += 1
            del self.pending[:written]
            time.sleep(0.005)
