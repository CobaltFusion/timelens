#!/usr/bin/env python3

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path


LOG_DIR = Path(r"C:\temp\logs\telemetry")
LOG_FILE = LOG_DIR / "telemetry_test_123_345.vson"

PID = 123


def _timestamp_us(start_ns: int) -> int:
    """Return microseconds since start_ns."""
    return (time.perf_counter_ns() - start_ns) // 1_000


def write_event(
    name: str,
    category: str,
    phase: str,
    tid: int,
    start_ns: int,
) -> None:
    event = {
        "name": name,
        "cat": category,
        "ph": phase,
        "pid": PID,
        "tid": tid,
        "ts": _timestamp_us(start_ns),
    }

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Always append, and don't buffer the writes.
    with LOG_FILE.open("ab", buffering=0) as f:
        f.write((json.dumps(event) + ",\n").encode("utf-8"))


def add_event(name: str, category: str, duration_ms: float) -> None:
    """Write a single event immediately."""
    start_ns = time.perf_counter_ns()
    write_event(name, category, "B", tid=345, start_ns=start_ns)

    try:
        time.sleep(duration_ms / 1000.0)
    finally:
        write_event(name, category, "E", tid=345, start_ns=start_ns)


@dataclass(frozen=True)
class ScheduledEvent:
    tid: int
    name: str
    category: str
    start_ms: float
    duration_ms: float


class EventScheduler:
    def __init__(self) -> None:
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

            # Sleep when there is plenty of time left, then busy-wait
            # for the final millisecond for better timing accuracy.
            if remaining_ns > 1_000_000:
                time.sleep((remaining_ns - 500_000) / 1_000_000_000)

    def play(self) -> None:
        """Play all scheduled events according to their start offsets."""
        actions = []

        for event in self.events:
            actions.append(
                (
                    event.start_ms,
                    0,  # B before E at the same timestamp.
                    event,
                    "B",
                )
            )
            actions.append((event.start_ms + event.duration_ms, 1, event, "E"))

        actions.sort(key=lambda action: (action[0], action[1]))

        start_ns = time.perf_counter_ns()

        for offset_ms, _, event, phase in actions:
            target_ns = start_ns + int(offset_ms * 1_000_000)
            self._wait_until(target_ns)

            write_event(event.name, event.category, phase, tid=event.tid, start_ns=start_ns)


def sequence_test() -> None:
    """Generate a 300 ms event containing overlapping events."""
    scheduler = EventScheduler()
    scheduler.schedule_event(tid=100, name="test", start=0, duration_ms=300)
    scheduler.schedule_event(tid=100, name="prepare", start=0, duration_ms=20)
    scheduler.schedule_event(tid=100, name="process", start=20, duration_ms=20)
    scheduler.schedule_event(tid=100, name="stop", start=280, duration_ms=20)
    scheduler.play()


def sequence(sequence_id: str) -> None:
    match sequence_id:
        case "test":
            sequence_test()
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

    if args.sequence is not None:
        if args.category is not None or args.duration_ms is not None:
            parser.error("-c/--category and -d/--duration-ms cannot be used with -s")

        try:
            sequence(args.sequence)
        except ValueError as exc:
            parser.error(str(exc))

        return

    if args.category is None:
        parser.error("-c/--category is required with -n/--name")

    if args.duration_ms is None:
        parser.error("-d/--duration-ms is required with -n/--name")

    add_event(args.name, args.category, args.duration_ms)


if __name__ == "__main__":
    main()
