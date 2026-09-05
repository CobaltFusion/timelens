#!/usr/bin/env python3

import argparse
import json
import time
from pathlib import Path


LOG_DIR = Path(r"C:\temp\logs\telemetry")
LOG_FILE = LOG_DIR / "telemetry_test_123_345.vson"

# Epoch for the test timestamps.
_EPOCH_NS = time.perf_counter_ns()


def _timestamp_us() -> int:
    """Return microseconds since the test epoch."""
    return (time.perf_counter_ns() - _EPOCH_NS) // 1_000


def write_event(name: str, category: str, phase: str) -> None:
    event = {
        "name": name,
        "cat": category,
        "ph": phase,
        "pid": 123,
        "tid": 345,
        "ts": _timestamp_us(),
    }

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Always append, and don't buffer the writes.
    with LOG_FILE.open("ab", buffering=0) as f:
        f.write((json.dumps(event) + ",\n").encode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a telemetry B/E event for testing."
    )

    parser.add_argument(
        "name",
        help="Name of the telemetry event.",
    )

    parser.add_argument(
        "category",
        help="Telemetry category.",
    )

    parser.add_argument(
        "duration_ms",
        type=float,
        help="Duration of the event in milliseconds.",
    )

    args = parser.parse_args()

    write_event(args.name, args.category, "B")

    try:
        time.sleep(args.duration_ms / 1000.0)
    finally:
        write_event(args.name, args.category, "E")


if __name__ == "__main__":
    main()
