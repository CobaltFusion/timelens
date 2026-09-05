#!/usr/bin/env python3

import functools
import json
import os
import threading
import time
from pathlib import Path


LOG_DIR = Path(r"C:\temp\logs\telemetry")

# Epoch for all timestamps in this process.
_EPOCH_NS = time.perf_counter_ns()

# One log file per thread.
_thread_log = threading.local()


def _timestamp_us() -> int:
    """Return microseconds since the process-local telemetry epoch."""
    return (time.perf_counter_ns() - _EPOCH_NS) // 1_000


def _get_log_file():
    """Return the unbuffered log file for the current thread."""
    if not hasattr(_thread_log, "file"):
        pid = os.getpid()
        tid = threading.get_native_id()

        # Replace this with whatever identifies your application.
        process_name = Path(os.path.basename(__file__)).stem

        LOG_DIR.mkdir(parents=True, exist_ok=True)

        filename = LOG_DIR / f"telemetry_{process_name}_{pid}_{tid}.vson"

        # buffering=0 means writes go directly through the unbuffered
        # Python file object.
        _thread_log.file = filename.open("ab", buffering=0)

    return _thread_log.file


def _write_event(name: str, category: str, phase: str) -> None:
    event = {
        "name": name,
        "cat": category,
        "ph": phase,
        "pid": os.getpid(),
        "tid": threading.get_native_id(),
        "ts": _timestamp_us(),
    }

    data = (json.dumps(event) + ",\n").encode("utf-8")

    _get_log_file().write(data)


def telemetry(category: str):
    """Decorate a function to generate B/E telemetry events."""

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            _write_event(func.__qualname__, category, "B")
            try:
                return func(*args, **kwargs)
            finally:
                _write_event(func.__qualname__, category, "E")

        return wrapper

    return decorator
