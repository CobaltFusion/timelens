#!/usr/bin/env python3

import argparse
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


LOG_DIR = Path(r"C:\temp\logs\telemetry")
LOG_FILE = LOG_DIR / "telemetry_test_123_345.vson"
COUNTER_FILE = LOG_DIR / "telemetry_test.counter"

PID = 123

# VSON timestamp epoch.
_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _timestamp_us() -> int:
    """Return microseconds since 1-Jan-2026 UTC."""
    now = datetime.now(timezone.utc)
    return int((now - _EPOCH).total_seconds() * 1_000_000)


def _next_counter() -> int:
    """Return the next persistent invocation counter."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    try:
        counter = int(COUNTER_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        counter = 0

    counter += 1
    COUNTER_FILE.write_text(str(counter))

    return counter


def _event_name(counter: int, name: str) -> str:
    return f"{counter}_{name}"


def write_event(counter: int, name: str, category: str, phase: str, tid: int) -> None:
    event = {"name": _event_name(counter, name), "cat": category, "ph": phase, "pid": PID, "tid": tid, "ts": _timestamp_us()}

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Always append, and don't buffer the writes.
    with LOG_FILE.open("ab", buffering=0) as f:
        f.write((json.dumps(event) + ",\n").encode("utf-8"))


def add_event(counter: int, name: str, category: str, duration_ms: float) -> None:
    """Write a single event immediately."""
    write_event(counter, name, category, "B", tid=345)

    try:
        time.sleep(duration_ms / 1000.0)
    finally:
        write_event(counter, name, category, "E", tid=345)


@dataclass(frozen=True)
class ScheduledEvent:
    tid: int
    name: str
    category: str
    start_ms: float
    duration_ms: float


class EventScheduler:
    def __init__(self, counter: int) -> None:
        self.counter = counter
        self.events: list[ScheduledEvent] = []

    def schedule_event(self, tid: int, name: str, start: float, duration_ms: float, category: str = "sequence") -> None:
        self.events.append(ScheduledEvent(tid=tid, name=name, category=category, start_ms=start, duration_ms=duration_ms))

    @staticmethod
    def _wait_until(target_ns: int) -> None:
        """Wait until the monotonic clock reaches target_ns."""
        while True:
            remaining_ns = target_ns - time.perf_counter_ns()

            if remaining_ns <= 0:
                return

            # Sleep for the coarse part and busy-wait for the
            # final millisecond to get better timing accuracy.
            if remaining_ns > 1_000_000:
                time.sleep((remaining_ns - 500_000) / 1_000_000_000)

    def play(self) -> None:
        """Play all scheduled events at their requested offsets."""
        actions = []

        for event in self.events:
            actions.append((event.start_ms, 0, event, "B"))
            actions.append((event.start_ms + event.duration_ms, 1, event, "E"))

        # Sort by timestamp. B is emitted before E at the same timestamp.
        actions.sort(key=lambda action: (action[0], action[1]))

        # Use a monotonic clock for scheduling so system clock changes
        # do not affect the timing of the generated sequence.
        playback_start_ns = time.perf_counter_ns()

        for offset_ms, _, event, phase in actions:
            target_ns = playback_start_ns + int(offset_ms * 1_000_000)

            self._wait_until(target_ns)

            write_event(self.counter, event.name, event.category, phase, tid=event.tid)


def sequence_test(counter: int) -> None:
    """Generate a 300 ms event containing several timed events."""
    scheduler = EventScheduler(counter)

    scheduler.schedule_event(tid=100, name="test", start=0, duration_ms=300)

    scheduler.schedule_event(tid=100, name="prepare", start=0, duration_ms=20)

    scheduler.schedule_event(tid=100, name="process", start=20, duration_ms=20)

    scheduler.schedule_event(tid=100, name="stop", start=280, duration_ms=20)

    scheduler.play()


def sequence(counter: int, sequence_id: str) -> None:
    match sequence_id:
        case "test":
            sequence_test(counter)
        case _:
            raise ValueError(f"Unknown sequence: {sequence_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate telemetry events for testing.")

    mode = parser.add_mutually_exclusive_group(required=True)

    mode.add_argument("-n", "--name", help="Name of the telemetry event.")

    mode.add_argument("-s", "--sequence", metavar="SEQUENCE_ID", help="Generate a predefined event sequence.")

    parser.add_argument("-c", "--category", help="Telemetry category.")

    parser.add_argument("-d", "--duration-ms", type=float, metavar="MILLISECONDS", help="Duration of the event in milliseconds.")

    args = parser.parse_args()

    counter = _next_counter()

    if args.sequence is not None:
        if args.category is not None or args.duration_ms is not None:
            parser.error("-c/--category and -d/--duration-ms cannot be used with -s")

        try:
            sequence(counter, args.sequence)
        except ValueError as exc:
            parser.error(str(exc))

        return

    if args.category is None:
        parser.error("-c/--category is required with -n/--name")

    if args.duration_ms is None:
        parser.error("-d/--duration-ms is required with -n/--name")

    add_event(counter, args.name, args.category, args.duration_ms)


if __name__ == "__main__":
    main()
