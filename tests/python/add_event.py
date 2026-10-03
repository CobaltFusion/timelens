#!/usr/bin/env python3

import argparse
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


LOG_DIR = Path(r"C:\temp\logs\telemetry")
LOG_FILE = LOG_DIR / "telemetry_test_123_345.vson"
COUNTER_FILE = LOG_DIR / "telemetry_test.counter"

PID = 123

# Used when the script is run without any arguments.
DEFAULT_ARGS = ["-n", "pre", "-n", "error", "-n", "post", "-c", "loop", "-d", "20", "-d", "100", "-d", "10",
                "-l", "--real", "--prefix"]

# VSON timestamp epoch.
_EPOCH = datetime(2026, 9, 1, tzinfo=timezone.utc)


def _timestamp_us() -> int:
    """Return microseconds since 1-Sept-2026 UTC."""
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


def write_event(counter: int, name: str, category: str, phase: str, tid: int, fixed: bool, ts: int, prefix: bool) -> None:

    if not fixed:
        ts = _timestamp_us()

    event = ""
    if prefix:
        event = {"name": _event_name(counter, name), "cat": category, "ph": phase, "pid": PID, "tid": tid, "ts": ts}
    else:
        event = {"name": name, "cat": category, "ph": phase, "pid": PID, "tid": tid, "ts": ts}

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Always append, and don't buffer the writes.
    with LOG_FILE.open("ab", buffering=0) as f:
        f.write((json.dumps(event) + ",\n").encode("utf-8"))


def loop(action) -> None:
    """Call action(counter) every 1 second until interrupted."""

    print("Repeating every 1 second. Press Ctrl+C to stop.")
    next_event = time.perf_counter()
    try:
        while True:
            next_event += 1.0
            action(_next_counter())

            remaining = next_event - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
            else:
                next_event = time.perf_counter()
    except KeyboardInterrupt:
        print("\nStopped.")


@dataclass(frozen=True)
class ScheduledEvent:
    tid: int
    name: str
    category: str
    start_ms: float
    duration_ms: float


class EventScheduler:
    def __init__(self, counter: int, fixed: bool, prefix: bool) -> None:
        self.counter = counter
        self.fixed = fixed
        self.prefix = prefix
        self.events: list[ScheduledEvent] = []

    def schedule_event(self, tid: int, name: str, start: float, duration_ms: float, category: str) -> None:
        self.events.append(ScheduledEvent(tid, name, category, start, duration_ms))

    @staticmethod
    def _wait_until(target_ns: int) -> None:
        """Wait until the monotonic clock reaches target_ns."""
        while True:
            remaining_ns = target_ns - time.perf_counter_ns()
            if remaining_ns <= 0:
                return
            time.sleep(remaining_ns / 1_000_000_000)

    def play(self) -> None:
        """Play all scheduled events at their requested offsets."""
        actions = []

        for event in self.events:
            actions.append((event.start_ms, 1, event, "B"))
            actions.append((event.start_ms + event.duration_ms, 0, event, "E"))

        # Sort by timestamp. E is emitted before B at the same timestamp,
        # so back-to-back events close before the next one opens.
        actions.sort(key=lambda action: (action[0], action[1]))

        # Use a monotonic clock for scheduling so system clock changes
        # do not affect the timing of the generated sequence.
        playback_start_ns = time.perf_counter_ns()
        playback_start_us = _timestamp_us()
        for offset_ms, _, event, phase in actions:
            target_ns = playback_start_ns + int(offset_ms * 1000_000)
            self._wait_until(target_ns)
            ts = playback_start_us + int(offset_ms * 1000)
            write_event(self.counter, event.name, event.category, phase, event.tid, self.fixed, ts, self.prefix)


def play_sequence(counter: int, steps: list[tuple[str, str, float]], fixed: bool, prefix: bool) -> None:
    """Play (name, category, duration_ms) steps back to back."""
    scheduler = EventScheduler(counter, fixed, prefix)
    start_ms = 0.0
    for name, category, duration_ms in steps:
        scheduler.schedule_event(345, name, start_ms, duration_ms, category)
        start_ms += duration_ms
    scheduler.play()


def print_summary(steps: list[tuple[str, str, float]], args: argparse.Namespace) -> None:
    """Print the events that will be written, with their offsets and durations."""
    name_width = max(len("name"), *(len(name) for name, _, _ in steps))
    category_width = max(len("category"), *(len(category) for _, category, _ in steps))

    print(f"Writing to {LOG_FILE}")
    print(f"Timing: {args.timing}, prefix: {'yes' if args.prefix else 'no'}, loop: {'yes' if args.loop else 'no'}")
    print(f"  {'name':<{name_width}}  {'category':<{category_width}}  {'start':>10}  {'duration':>10}")
    start_ms = 0.0
    for name, category, duration_ms in steps:
        print(f"  {name:<{name_width}}  {category:<{category_width}}  {start_ms:>7.1f} ms  {duration_ms:>7.1f} ms")
        start_ms += duration_ms
    print(f"  total: {len(steps)} events, {start_ms:.1f} ms")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate telemetry events for testing. Repeat -n/-c/-d to describe a sequence of back-to-back events.",
        epilog=f"example (also the default when run without arguments):\n  %(prog)s {' '.join(DEFAULT_ARGS)}",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-n", "--name", action="append", required=True, help="Name of the telemetry event (repeatable).")
    parser.add_argument("-c", "--category", action="append", required=True,
                        help="Telemetry category (repeatable; give once to apply to all events).")
    parser.add_argument("-d", "--duration-ms", action="append", type=float, required=True, metavar="MILLISECONDS",
                        help="Duration of the event in milliseconds (repeatable; give once to apply to all events).")
    parser.add_argument("-l", "--loop", action="store_true", help="Repeat the sequence every 1 second until interrupted.")
    timing = parser.add_mutually_exclusive_group()
    timing.add_argument("--real", dest="timing", action="store_const", const="real",
                        help="Timestamps taken from the wall clock when each event is written (default).")
    timing.add_argument("--fixed", dest="timing", action="store_const", const="fixed",
                        help="Events are written at wall clock time, but timestamps are ideal values "
                             "computed from the requested durations.")
    parser.set_defaults(timing="real")
    parser.add_argument("-p", "--prefix", action="store_true", help="Prefix event names with the invocation counter.")
    if len(sys.argv) > 1:
        args = parser.parse_args()
    else:
        print(f"No arguments given, using defaults: {' '.join(DEFAULT_ARGS)}")
        args = parser.parse_args(DEFAULT_ARGS)

    count = len(args.name)

    def expand(values: list, option: str) -> list:
        if len(values) == 1:
            return values * count
        if len(values) != count:
            parser.error(f"{option} must be given once or once per -n/--name ({count} times), got {len(values)}")
        return values

    categories = expand(args.category, "-c/--category")
    durations = expand(args.duration_ms, "-d/--duration-ms")
    steps = list(zip(args.name, categories, durations))

    fixed = args.timing == "fixed"

    print_summary(steps, args)

    def action(counter):
        play_sequence(counter, steps, fixed, args.prefix)

    if args.loop:
        loop(action)
    else:
        action(_next_counter())


if __name__ == "__main__":
    main()
