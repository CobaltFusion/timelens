#!/usr/bin/env python3

from __future__ import annotations

import bisect
import logging

logger = logging.getLogger(__name__)

# Spans that began more than this before the newest span are dropped.
DEFAULT_RETENTION_US = 30 * 60 * 1_000_000

# Queries leave out open spans that began more than this before the newest event, like the
# webclient's buffer, which keeps the last minute. A span that never ends would otherwise be shown forever.
DEFAULT_OPEN_HISTORY_US = 60 * 1_000_000

RISING = "rising"     # the begin of a span
FALLING = "falling"   # the end of a span


# Returns a test for spans, true for a closed span whose duration is longer ('>') or shorter ('<')
# than 'limit_us'. An open span has no duration yet, it never passes.
def make_duration_test(op, limit_us):
    if op == ">":
        return lambda span: span["end"] is not None and span["end"] - span["ts"] > limit_us
    if op == "<":
        return lambda span: span["end"] is not None and span["end"] - span["ts"] < limit_us
    raise ValueError(f"unknown duration comparison {op!r}, expected '>' or '<'")


class SpanStore:
    """
    In-memory store of spans, sorted by their begin time 'ts' (µs).

    Raw Chrome trace events are paired into spans:
      'B' opens a span, the matching 'E' closes it ('end' is set on the same dict),
      'X' is a complete span with 'end' = 'ts' + 'dur'.
    A span is a dict: id, name, cat, pid, tid, source, count, ts (begin), end (None while open).
    """

    def __init__(self, retention_us=DEFAULT_RETENTION_US, open_history_us=DEFAULT_OPEN_HISTORY_US):
        self.retention_us = retention_us
        self.open_history_us = open_history_us
        self.max_duration_us = 0
        self.newest_us = float("-inf")    # the latest begin or end time added
        self._begin: list[float] = []   # parallel to '_spans', used for bisect
        self._spans: list[dict] = []
        self._open: dict[tuple, list[dict]] = {}    # (source, pid, tid) -> stack of open spans
        self._next_id = 1

    def __len__(self):
        return len(self._spans)

    # Adds a raw event. Returns (span, edges), the new or closed span and the
    # [(edge, time_us)] it caused. An 'E' without an open span returns (None, []).
    def add(self, evt):
        ph = evt.get("ph")
        ts = evt["ts"]
        thread = (evt.get("source"), evt.get("pid"), evt.get("tid"))
        self.newest_us = max(self.newest_us, ts)

        if ph == "E":
            span = self._pop_open(thread, evt.get("name"))
            if span is None:
                logger.debug("unmatched end event: %s", evt)
                return None, []
            span["end"] = max(ts, span["ts"])
            self._closed(span)
            return span, [(FALLING, span["end"])]

        span = self._insert(evt)

        if ph == "X":
            span["end"] = ts + (evt.get("dur") or 0)
            self.newest_us = max(self.newest_us, span["end"])
            self._closed(span)
            return span, [(RISING, ts), (FALLING, span["end"])]

        # 'B', and like before, any other phase opens a span
        self._open.setdefault(thread, []).append(span)
        return span, [(RISING, ts)]

    # Returns (spans, truncated), the spans that overlap [start_us, end_us], ordered by begin.
    # Open spans are included, unless they began more than 'open_history_us' before the newest event.
    # Only spans for which 'accept(span)' is true are included, when it is given.
    # When there are more than 'limit', the newest are returned.
    def query(self, start_us, end_us, limit=None, accept=None):
        earliest_us = start_us - self.max_duration_us
        begin = bisect.bisect_left(self._begin, earliest_us)
        end = bisect.bisect_right(self._begin, end_us)
        open_cutoff_us = self.newest_us - self.open_history_us

        # open spans can be longer than 'max_duration_us', those are not in the slice
        spans = sorted(
            (span for stack in self._open.values() for span in stack if open_cutoff_us <= span["ts"] < earliest_us),
            key=lambda span: span["ts"],
        )
        spans.extend(
            span for span in self._spans[begin:end]
            if (span["ts"] >= open_cutoff_us if span["end"] is None else span["end"] >= start_us)
        )
        if accept is not None:
            spans = [span for span in spans if accept(span)]

        truncated = False
        if limit is not None and len(spans) > limit:
            spans = spans[-limit:]
            truncated = True

        return spans, truncated

    # Duration statistics per name over the closed spans that begin in [start_us, end_us]:
    # {name: {count, min, max, mean, m2}}, 'm2' is the sum of squared differences from the mean.
    def stats(self, start_us, end_us, accept=None):
        begin = bisect.bisect_left(self._begin, start_us)
        end = bisect.bisect_right(self._begin, end_us)
        result = {}

        for span in self._spans[begin:end]:
            if span["end"] is None or (accept is not None and not accept(span)):
                continue

            duration_us = span["end"] - span["ts"]
            s = result.get(span["name"])
            if s is None:
                s = {"count": 0, "min": duration_us, "max": duration_us, "mean": 0.0, "m2": 0.0}
                result[span["name"]] = s

            # Welford's online algorithm, numerically stable for mean and variance.
            s["count"] += 1
            delta = duration_us - s["mean"]
            s["mean"] += delta / s["count"]
            s["m2"] += delta * (duration_us - s["mean"])
            s["min"] = min(s["min"], duration_us)
            s["max"] = max(s["max"], duration_us)

        return result

    # The time of the first or last ('which') edge in [start_us, end_us] of a span whose
    # name matches, or None. A 'rising' edge is the begin, a 'falling' edge the end of a closed span.
    # With 'duration' (see 'make_duration_test') only closed spans with a matching duration count,
    # the time is still the begin or the end of the span.
    def find(self, matcher, edge, start_us, end_us, which="last", accept=None, duration=None):
        def accepted(span):
            return (matcher(span["name"]) and (accept is None or accept(span))
                    and (duration is None or duration(span)))

        if edge == FALLING:
            begin = bisect.bisect_left(self._begin, start_us - self.max_duration_us)
            end = bisect.bisect_right(self._begin, end_us)
            times = [
                span["end"]
                for span in self._spans[begin:end]
                if span["end"] is not None and start_us <= span["end"] <= end_us and accepted(span)
            ]
            if not times:
                return None
            return min(times) if which == "first" else max(times)

        begin = bisect.bisect_left(self._begin, start_us)
        end = bisect.bisect_right(self._begin, end_us)
        indices = range(begin, end) if which == "first" else range(end - 1, begin - 1, -1)

        for i in indices:
            span = self._spans[i]
            if accepted(span):
                return span["ts"]
        return None

    # (first_begin, last_begin) or None when empty
    def bounds(self):
        if not self._begin:
            return None
        return self._begin[0], self._begin[-1]

    def clear(self):
        self._begin.clear()
        self._spans.clear()
        self._open.clear()
        self.max_duration_us = 0
        self.newest_us = float("-inf")

    def _insert(self, evt):
        ts = evt["ts"]
        span = {
            "id": self._next_id,
            "name": evt.get("name", ""),
            "cat": evt.get("cat"),
            "pid": evt.get("pid"),
            "tid": evt.get("tid"),
            "source": evt.get("source"),
            "count": evt.get("count"),
            "ts": ts,
            "end": None,
        }
        self._next_id += 1

        index = bisect.bisect_right(self._begin, ts)
        self._begin.insert(index, ts)
        self._spans.insert(index, span)
        self._trim()
        return span

    # The most recent open span on 'thread' with 'name', or the most recent one if 'name' is empty.
    def _pop_open(self, thread, name):
        stack = self._open.get(thread)
        if not stack:
            return None

        index = len(stack) - 1
        if name:
            while index >= 0 and stack[index]["name"] != name:
                index -= 1
            if index < 0:
                return None

        span = stack.pop(index)
        if not stack:
            del self._open[thread]
        return span

    def _closed(self, span):
        self.max_duration_us = max(self.max_duration_us, span["end"] - span["ts"])

    # Drops spans that began before the retention time, open spans stay on their stack.
    # Only trims once more than ~10% of the spans are expired, so the lists are not
    # shifted on every add.
    def _trim(self):
        cutoff = self._begin[-1] - self.retention_us
        expired = bisect.bisect_left(self._begin, cutoff)

        if expired == 0 or expired * 10 < len(self._begin):
            return

        del self._begin[:expired]
        del self._spans[:expired]
