#!/usr/bin/env python3
"""
A statistical summary of the events in the log files of the server, on the command line.

The files are read once, entirely (the server only reads the last 30 minutes of a file), and the begin
and end events are paired into spans the way the server does. The spans are grouped by the combination
of name, pid and tid, and for every group the durations are summarized: count, total, min, mean,
percentiles, max and standard deviation. The process and thread are shown by their name when the log
files give one (a 'process_name' or 'thread_name' metadata event), otherwise by their number.

The counter events ('C', like the cpu usage the server logs) are summarized the same way, per series: a
numeric value in the 'args' of a counter of a process. A counter has no duration, so its values are used.

    python -m timelens.summary [path ...] [--sort total] [--top 20] [--name "proc*"] [--skip 5] [--skip-seconds 10] [--format csv]

A path is a '*.vson' file or a folder with them, by default the folder the server watches.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from array import array
from pathlib import Path

from timelens.names import Names, is_metadata
from timelens.span_store import SPAN_PHASES
from timelens.vson import default_log_directory, find_log_files, parse_line
from timelens.wildcard import make_wildcard_matcher

COUNTER_PHASE = "C"

# percentiles shown in the summary, they need the durations of a group in memory (8 bytes per event)
PERCENTILES = (50, 95, 99)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class Pairer:
    """
    Pairs the events of a log file into closed spans, the way 'SpanStore' does, without keeping them:
    'B' opens a span, the next 'E' on the same thread closes the innermost open span with its name
    (or the innermost one if the 'E' has no name), and 'X' is a complete span with a duration.
    Other phases are ignored. A thread is the combination of file, pid and tid.
    """

    def __init__(self):
        self._open = {}                 # (source, pid, tid) -> stack of (name, begin)
        self.unmatched_ends = 0

    # Returns (name, pid, tid, begin, end) when the event closes a span, otherwise None.
    def add(self, evt):
        if is_metadata(evt):
            return None     # the name of a process or thread, not an event

        ph = evt.get("ph")
        if ph not in SPAN_PHASES:
            return None     # counters ('C'), instants ('i') and the like are not used

        ts = evt["ts"]
        thread = (evt.get("source"), evt.get("pid"), evt.get("tid"))

        if ph == "E":
            popped = self._pop_open(thread, evt.get("name"))
            if popped is None:
                self.unmatched_ends += 1
                return None
            name, begin = popped
            return name, thread[1], thread[2], begin, max(ts, begin)

        name = evt.get("name", "")
        if ph == "X":
            duration = evt.get("dur")
            return name, thread[1], thread[2], ts, ts + (duration if is_number(duration) else 0)

        self._open.setdefault(thread, []).append((name, ts))
        return None

    # (name, pid, tid) of every span that was opened and not closed
    def open_spans(self):
        for name, pid, tid, _ in self.open_begins():
            yield name, pid, tid

    # (name, pid, tid, begin) of every span that was opened and not closed
    def open_begins(self):
        for (_, pid, tid), stack in self._open.items():
            for name, begin in stack:
                yield name, pid, tid, begin

    def _pop_open(self, thread, name):
        stack = self._open.get(thread)
        if not stack:
            return None

        index = len(stack) - 1
        if name:
            while index >= 0 and stack[index][0] != name:
                index -= 1
            if index < 0:
                return None

        popped = stack.pop(index)
        if not stack:
            del self._open[thread]
        return popped


def percentile(sorted_values, q):
    """The q-th percentile (0 to 100) of sorted values, interpolated between the two nearest ranks."""
    if not sorted_values:
        return None
    rank = (len(sorted_values) - 1) * q / 100
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return sorted_values[low]
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (rank - low)


class GroupStats:
    """
    The durations (us) of the spans of one group, the mean and variance are updated per span. The first 'skip'
    spans are not counted, like the warming up of a program. Also used for the values of a counter series.
    """

    def __init__(self, keep_durations, skip=0):
        self.skip = skip            # spans that are still to be skipped
        self.skipped = 0
        self.count = 0
        self.total_us = 0
        self.min_us = None
        self.max_us = None
        self.mean_us = 0.0
        self.m2 = 0.0               # sum of the squared differences from the mean
        self.open = 0               # spans that were opened and never closed
        self.percentiles = {}       # q -> duration, set by 'finish()'
        self._durations = array("d") if keep_durations else None

    def add(self, duration_us):
        if self.skip > 0:
            self.skip -= 1
            self.skipped += 1
            return

        self.count += 1
        self.total_us += duration_us
        self.min_us = duration_us if self.min_us is None else min(self.min_us, duration_us)
        self.max_us = duration_us if self.max_us is None else max(self.max_us, duration_us)

        # Welford's online algorithm, numerically stable for mean and variance
        delta = duration_us - self.mean_us
        self.mean_us += delta / self.count
        self.m2 += delta * (duration_us - self.mean_us)

        if self._durations is not None:
            self._durations.append(duration_us)

    # sample standard deviation, None for fewer than two spans
    @property
    def stddev_us(self):
        return math.sqrt(self.m2 / (self.count - 1)) if self.count > 1 else None

    def finish(self):
        if self._durations is not None:
            durations = sorted(self._durations)
            self.percentiles = {q: percentile(durations, q) for q in PERCENTILES}
            self._durations = array("d")    # the memory is not needed anymore


class Summarizer:
    """Reads events and summarizes the spans per group: (name, pid, tid), and the counters per series: (name, key, pid)."""

    # 'skip' is the number of spans (or counter values) at the start of every group that are not counted, and
    # those in the first 'skip_seconds' (from the first event of the first file) are not counted either
    def __init__(self, keep_durations=True, skip=0, skip_seconds=0):
        self.keep_durations = keep_durations
        self.skip = max(skip, 0)
        self.skip_us = max(skip_seconds, 0) * 1_000_000
        self.early_spans = 0            # spans that begin in the first 'skip_seconds'
        self._start = None              # ts of the first event of the first file
        self.pairer = Pairer()
        self.names = Names()            # the names of the processes and threads, from the metadata events
        self.groups = {}
        self.counters = {}              # (name, key, pid) -> GroupStats of the values
        self.counter_events = 0
        self.early_counter_events = 0   # counter events in the first 'skip_seconds'
        self.files = 0
        self.events = 0
        self.skipped_lines = 0          # lines that are not a JSON object
        self.events_without_time = 0    # events without a numeric 'ts'
        self.ignored_events = 0         # events of another phase than B, E, X and C, like instants

    def add_event(self, evt):
        if is_metadata(evt):
            self.names.add(evt)     # not an event: the name of a process or thread, used to show the groups
            return
        ph = evt.get("ph")
        if ph not in SPAN_PHASES and ph != COUNTER_PHASE:
            self.ignored_events += 1
            return

        ts = evt.get("ts")
        if not is_number(ts):
            self.events_without_time += 1
            return
        if self._start is None:
            self._start = ts

        if ph == COUNTER_PHASE:
            self._add_counter(evt, ts)
            return
        self.events += 1

        span = self.pairer.add(evt)
        if span is None:
            return
        name, pid, tid, begin, end = span
        if self._is_early(begin):
            self.early_spans += 1
            return
        self._group((name, pid, tid)).add(end - begin)

    # Reads all lines of a file. 'progress(read, size)' is called now and then, the sizes are in characters.
    def read_file(self, path, progress=None):
        path = Path(path)
        size = path.stat().st_size
        read = 0
        self.files += 1

        with path.open("r", encoding="utf8", errors="replace") as f:
            for line in f:
                read += len(line)
                if progress is not None:
                    progress(read, size)
                try:
                    evt = parse_line(line)
                except ValueError:
                    self.skipped_lines += 1
                    continue
                if evt is not None:
                    evt["source"] = path.name       # like the server, a thread is per file
                    self.add_event(evt)

    # Every numeric value in the 'args' of a counter event is a sample of its own series.
    def _add_counter(self, evt, ts):
        self.counter_events += 1
        if self._is_early(ts):
            self.early_counter_events += 1
            return
        args = evt.get("args")
        if not isinstance(args, dict):
            return
        name, pid = evt.get("name", ""), evt.get("pid")
        for key, value in args.items():
            if is_number(value):
                stats = self.counters.get((name, key, pid))
                if stats is None:
                    stats = GroupStats(self.keep_durations, self.skip)
                    self.counters[(name, key, pid)] = stats
                stats.add(value)

    # Call when all events are added: the spans that are still open are counted, and the percentiles are made.
    def finish(self):
        for name, pid, tid, begin in self.pairer.open_begins():
            if self._is_early(begin):
                self.early_spans += 1
            else:
                self._group((name, pid, tid)).open += 1
        for stats in (*self.groups.values(), *self.counters.values()):
            stats.finish()

    @property
    def skipped_spans(self):
        return sum(stats.skipped for stats in self.groups.values())

    @property
    def skipped_counter_values(self):
        return sum(stats.skipped for stats in self.counters.values())

    @property
    def unmatched_ends(self):
        return self.pairer.unmatched_ends

    def rows(self):
        """One dict per group, the process and thread are a name or a number, the durations are in us."""
        rows = []
        for (name, pid, tid), stats in self.groups.items():
            row = {
                "name": name, "process": self.process_of(pid), "thread": self.thread_of(pid, tid), "count": stats.count,
                "total_us": stats.total_us if stats.count else None,
                "min_us": stats.min_us, "mean_us": stats.mean_us if stats.count else None,
            }
            for q in PERCENTILES:
                row[f"p{q}_us"] = stats.percentiles.get(q)
            row.update({"max_us": stats.max_us, "stddev_us": stats.stddev_us, "open": stats.open})
            rows.append(row)
        return rows

    def counter_rows(self):
        """One dict per counter series, the process is a name or a number."""
        rows = []
        for (name, key, pid), stats in self.counters.items():
            row = {
                "name": name, "series": key, "process": self.process_of(pid), "count": stats.count,
                "min": stats.min_us, "mean": stats.mean_us if stats.count else None,
            }
            for q in PERCENTILES:
                row[f"p{q}"] = stats.percentiles.get(q)
            row.update({"max": stats.max_us, "stddev": stats.stddev_us})
            rows.append(row)
        return sorted(rows, key=lambda row: (str(row["name"]), str(row["series"]), str(row["process"])))

    # the name of a process, or its pid when it has no name
    def process_of(self, pid):
        return self.names.processes.get(pid, pid)

    # the name of a thread, or its tid when it has no name
    def thread_of(self, pid, tid):
        return self.names.threads.get((pid, tid), tid)

    # whether a span that begins at 'begin' is in the first 'skip_seconds'
    def _is_early(self, begin):
        return self.skip_us > 0 and begin < self._start + self.skip_us

    def _group(self, key):
        stats = self.groups.get(key)
        if stats is None:
            stats = GroupStats(self.keep_durations, self.skip)
            self.groups[key] = stats
        return stats


def format_duration(duration_us, micro="µ"):
    """Like the hover text of the web client: us, ms or s with three decimals."""
    if duration_us is None:
        return "-"
    absolute = abs(duration_us)
    if absolute >= 1_000_000:
        return f"{duration_us / 1_000_000:.3f} s"
    if absolute >= 1_000:
        return f"{duration_us / 1_000:.3f} ms"
    return f"{duration_us:.0f} {micro}s"


def sort_rows(rows, sort):
    by_name = lambda row: (str(row["name"]), str(row["process"]), str(row["thread"]))
    if sort == "name":
        return sorted(rows, key=by_name)
    key = {"total": "total_us", "count": "count", "mean": "mean_us", "max": "max_us"}[sort]
    # biggest first, groups without a value (only open spans) last, equal values by name
    return sorted(sorted(rows, key=by_name), key=lambda row: row[key] if row[key] is not None else -1, reverse=True)


def render_table(rows, percentiles, micro="µ"):
    columns = [("name", lambda r: "(no name)" if r["name"] in (None, "") else str(r["name"]), "<"),
               ("process", lambda r: "-" if r["process"] is None else str(r["process"]), "<"),
               ("thread", lambda r: "-" if r["thread"] is None else str(r["thread"]), "<"),
               ("count", lambda r: f"{r['count']:,}", ">")]

    def duration_column(header, key):
        return (header, lambda r: format_duration(r[key], micro), ">")

    columns += [duration_column("total", "total_us"), duration_column("min", "min_us"), duration_column("mean", "mean_us")]
    if percentiles:
        columns += [duration_column(f"p{q}", f"p{q}_us") for q in PERCENTILES]
    columns += [duration_column("max", "max_us"), duration_column("stddev", "stddev_us"), ("open", lambda r: str(r["open"]), ">")]

    return layout_table(columns, rows)


def format_value(value):
    """A counter value, with up to two decimals."""
    if value is None:
        return "-"
    return f"{value:,.2f}".rstrip("0").rstrip(".") if value != int(value) else f"{int(value):,}"


def render_counter_table(rows, percentiles):
    columns = [("counter", lambda r: "(no name)" if r["name"] in (None, "") else str(r["name"]), "<"),
               ("series", lambda r: str(r["series"]), "<"),
               ("process", lambda r: "-" if r["process"] is None else str(r["process"]), "<"),
               ("count", lambda r: f"{r['count']:,}", ">")]

    def value_column(key):
        return (key, lambda r: format_value(r[key]), ">")

    columns += [value_column("min"), value_column("mean")]
    if percentiles:
        columns += [value_column(f"p{q}") for q in PERCENTILES]
    columns += [value_column("max"), value_column("stddev")]
    return layout_table(columns, rows)


# 'columns' are (header, getter of the text of a row, alignment)
def layout_table(columns, rows):
    cells = [[getter(row) for _, getter, _ in columns] for row in rows]
    widths = [max([len(header)] + [len(line[i]) for line in cells]) for i, (header, _, _) in enumerate(columns)]

    def line(values):
        return "  ".join(f"{value:{align}{width}}" for value, width, (_, _, align) in zip(values, widths, columns)).rstrip()

    lines = [line([header for header, _, _ in columns]), line(["-" * width for width in widths])]
    lines.extend(line(values) for values in cells)
    return "\n".join(lines)


def footer(summarizer, shown, total):
    parts = [f"{summarizer.events:,} events from {summarizer.files} file(s) in {total:,} groups"]
    if shown < total:
        parts.append(f"{shown:,} shown")
    if summarizer.counter_events:
        parts.append(f"{summarizer.counter_events:,} counter events in {len(summarizer.counters):,} series")
    if summarizer.early_counter_events:
        parts.append(f"{summarizer.early_counter_events:,} counter events in the first {summarizer.skip_us / 1_000_000:g} s skipped")
    if summarizer.skipped_counter_values:
        parts.append(f"the first {summarizer.skip:,} values of every counter series skipped ({summarizer.skipped_counter_values:,} in all)")
    if summarizer.early_spans:
        parts.append(f"{summarizer.early_spans:,} spans in the first {summarizer.skip_us / 1_000_000:g} s skipped")
    if summarizer.skipped_spans:
        parts.append(f"the first {summarizer.skip:,} spans of every group skipped ({summarizer.skipped_spans:,} in all)")
    if summarizer.skipped_lines:
        parts.append(f"{summarizer.skipped_lines:,} lines skipped")
    if summarizer.events_without_time:
        parts.append(f"{summarizer.events_without_time:,} events without a time ignored")
    if summarizer.ignored_events:
        parts.append(f"{summarizer.ignored_events:,} events of other types than B, E, X and C ignored")
    if summarizer.unmatched_ends:
        parts.append(f"{summarizer.unmatched_ends:,} end events without a begin ignored")
    return ", ".join(parts)


def can_print(text, stream):
    try:
        text.encode(getattr(stream, "encoding", None) or "ascii")
        return True
    except UnicodeEncodeError:
        return False


def make_progress_reporter(stream, name):
    """Prints how far a file is read to 'stream' a few times per second, on one line."""
    last = [0.0]

    def report(read, size):
        now = time.monotonic()
        if now - last[0] < 0.5:
            return
        last[0] = now
        percent = 100 * read / size if size else 100
        stream.write(f"\rreading {name}: {percent:5.1f}%")
        stream.flush()

    def done():
        stream.write("\r" + " " * (len(f"reading {name}: 100.0%") + 2) + "\r")
        stream.flush()

    return report, done


def build_parser():
    parser = argparse.ArgumentParser(
        prog="python -m timelens.summary",
        description="Summarizes the events of the log files per group of name, process and thread. The files "
                    "are read once, entirely. A process or thread is shown by its name if it has one.",
        epilog="The durations are of the spans the server makes of the events: a begin ('B') and its end ('E'), "
               "or a complete event ('X'). 'open' counts the begins that have no end. The counters ('C') are "
               "summarized in a second table, per series: a numeric value in their 'args'. The percentiles need "
               "8 bytes of memory per event, use --no-percentiles for very large files.")
    parser.add_argument("paths", nargs="*", metavar="path",
                        help="'*.vson' files or folders with them, default: the folder the server watches")
    parser.add_argument("--name", metavar="PATTERN",
                        help="only groups whose name matches, case-insensitive, '*' matches any text, "
                             "without '*' it matches anywhere in the name (like the trigger word), "
                             "a counter series matches by its counter or series name")
    parser.add_argument("--sort", choices=["total", "count", "mean", "max", "name"], default="total",
                        help="order of the groups, the biggest first (default: total), counters are by name")
    parser.add_argument("--skip", type=int, default=0, metavar="N",
                        help="omit the first N spans of every group (or values of every counter series), in the order of the log files, "
                             "like the warming up of a program (default: 0)")
    parser.add_argument("--skip-seconds", type=float, default=0, metavar="S",
                        help="omit the spans that begin (and counter values) in the first S seconds, counted from the first event "
                             "of the first log file (default: 0)")
    parser.add_argument("--top", type=int, metavar="N", help="only show the first N groups (of spans)")
    parser.add_argument("--format", choices=["table", "csv", "json"], default="table",
                        help="csv and json have the durations in microseconds (default: table)")
    parser.add_argument("--no-percentiles", action="store_true", help="do not keep the durations to make percentiles")
    parser.add_argument("--quiet", action="store_true", help="do not show the progress")
    return parser


def main(argv=None, stdout=None, stderr=None):
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    args = build_parser().parse_args(argv)

    try:
        files = find_log_files(args.paths or [default_log_directory()])
    except FileNotFoundError as exc:
        print(exc, file=stderr)
        return 1
    if not files:
        print("no '*.vson' files found", file=stderr)
        return 1

    percentiles = not args.no_percentiles
    summarizer = Summarizer(keep_durations=percentiles, skip=args.skip, skip_seconds=args.skip_seconds)
    show_progress = not args.quiet and getattr(stderr, "isatty", lambda: False)()
    for path in files:
        if show_progress:
            report, done = make_progress_reporter(stderr, path.name)
            summarizer.read_file(path, report)
            done()
        else:
            summarizer.read_file(path)
    summarizer.finish()

    rows = summarizer.rows()
    counter_rows = summarizer.counter_rows()
    if args.name:
        matches = make_wildcard_matcher(args.name)
        rows = [row for row in rows if matches(str(row["name"]))]
        counter_rows = [row for row in counter_rows if matches(str(row["name"])) or matches(str(row["series"]))]
    total = len(rows)
    rows = sort_rows(rows, args.sort)
    if args.top is not None:
        rows = rows[:max(args.top, 0)]

    if args.format == "json":
        json.dump({"files": [str(path) for path in files], "events": summarizer.events, "groups": rows,
                   "counter_events": summarizer.counter_events, "counters": counter_rows,
                   "skipped_lines": summarizer.skipped_lines, "skipped_spans": summarizer.skipped_spans,
                   "early_spans": summarizer.early_spans, "early_counter_events": summarizer.early_counter_events,
                   "skipped_counter_values": summarizer.skipped_counter_values,
                   "unmatched_ends": summarizer.unmatched_ends,
                   "events_without_time": summarizer.events_without_time,
                   "ignored_events": summarizer.ignored_events}, stdout, indent=2)
        stdout.write("\n")
        print(footer(summarizer, len(rows), total), file=stderr)
    elif args.format == "csv":
        fields = list(rows[0]) if rows else ["name", "process", "thread", "count"]
        writer = csv.DictWriter(stdout, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        if counter_rows:
            # a second table, after an empty line
            stdout.write("\n")
            writer = csv.DictWriter(stdout, fieldnames=list(counter_rows[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(counter_rows)
        print(footer(summarizer, len(rows), total), file=stderr)
    else:
        micro = "µ" if can_print("µ", stdout) else "u"
        if rows:
            print(render_table(rows, percentiles, micro), file=stdout)
        elif not counter_rows:
            print("no events", file=stdout)
        if counter_rows:
            print(("\n" if rows else "") + render_counter_table(counter_rows, percentiles), file=stdout)
        print("\n" + footer(summarizer, len(rows), total), file=stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
