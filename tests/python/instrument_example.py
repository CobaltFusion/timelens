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

# Protect writes if multiple threads are logging.
_LOCK = threading.Lock()


def _timestamp_us() -> int:
    """Return microseconds since the process-local telemetry epoch."""
    return (time.perf_counter_ns() - _EPOCH_NS) // 1_000


def _get_log_file() -> Path:
    """
    Create a filename such as:

        telemetry_processname_1029693_1029693.vson

    The first number is the process ID and the second is the thread ID.
    """
    pid = os.getpid()
    tid = threading.get_native_id()

    # Replace this with whatever identifies your application.
    process_name = Path(os.path.basename(__file__)).stem

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    return LOG_DIR / f"telemetry_{process_name}_{pid}_{tid}.vson"


def _write_event(name: str, category: str, phase: str) -> None:
    event = {
        "name": name,
        "cat": category,
        "ph": phase,
        "pid": os.getpid(),
        "tid": threading.get_native_id(),
        "ts": _timestamp_us(),
    }

    with _LOCK:
        with _get_log_file().open("a", encoding="utf-8") as f:
            json.dump(event, f)
            f.write(",\n")


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
