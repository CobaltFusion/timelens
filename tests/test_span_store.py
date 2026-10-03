#!/usr/bin/env python3

import math

from timelens.span_store import FALLING, RISING, SpanStore
from timelens.wildcard import make_wildcard_matcher

INF = float("inf")


def evt(ph, name, ts, tid=1, **extra):
    return {"ph": ph, "name": name, "ts": ts, "pid": 1, "tid": tid, "source": "a.vson", **extra}


def make_store(*events, retention_us=1_000_000):
    store = SpanStore(retention_us=retention_us)
    for e in events:
        store.add(e)
    return store


def spans_of(store, start_us=-INF, end_us=INF):
    spans, _ = store.query(start_us, end_us)
    return [(s["name"], s["ts"], s["end"]) for s in spans]


def test_begin_end_become_one_span():
    store = SpanStore()

    span, edges = store.add(evt("B", "a", 10))
    assert span["end"] is None
    assert edges == [(RISING, 10)]

    closed, edges = store.add(evt("E", "a", 30))
    assert closed is span
    assert closed["end"] == 30
    assert edges == [(FALLING, 30)]

    assert spans_of(store) == [("a", 10, 30)]


def test_nested_same_name_closes_innermost():
    store = make_store(evt("B", "a", 10), evt("B", "a", 20), evt("E", "a", 25), evt("E", "a", 40))

    assert spans_of(store) == [("a", 10, 40), ("a", 20, 25)]


def test_end_without_name_closes_most_recent():
    store = make_store(evt("B", "a", 10), evt("B", "b", 20), evt("E", "", 25))

    assert spans_of(store) == [("a", 10, None), ("b", 20, 25)]


def test_threads_are_paired_separately():
    store = make_store(evt("B", "a", 10, tid=1), evt("B", "a", 20, tid=2), evt("E", "a", 30, tid=1))

    assert spans_of(store) == [("a", 10, 30), ("a", 20, None)]


def test_unmatched_end_is_ignored():
    store = SpanStore()

    assert store.add(evt("E", "a", 10)) == (None, [])
    assert len(store) == 0


def test_complete_event():
    store = SpanStore()

    span, edges = store.add(evt("X", "a", 10, dur=5))

    assert span["end"] == 15
    assert edges == [(RISING, 10), (FALLING, 15)]


def test_query_includes_spans_that_began_before_the_range():
    store = make_store(evt("X", "long", 0, dur=100), evt("X", "short", 10, dur=1), evt("X", "late", 200, dur=1))

    assert spans_of(store, 50, 150) == [("long", 0, 100)]


def test_query_includes_open_spans_longer_than_any_closed_span():
    store = make_store(evt("B", "open", 0), evt("X", "short", 500, dur=1))

    assert spans_of(store, 400, 600) == [("open", 0, None), ("short", 500, 501)]


def test_query_limit_keeps_newest():
    store = make_store(*(evt("X", str(i), i * 10, dur=1) for i in range(4)))

    spans, truncated = store.query(-INF, INF, limit=2)

    assert [s["name"] for s in spans] == ["2", "3"]
    assert truncated


def test_stats():
    store = make_store(
        evt("X", "a", 0, dur=10), evt("X", "a", 10, dur=20), evt("X", "a", 20, dur=30),
        evt("B", "a", 30),          # open spans are not counted
        evt("X", "b", 40, dur=5),
    )

    stats = store.stats(-INF, INF)

    a = stats["a"]
    assert (a["count"], a["min"], a["max"], a["mean"]) == (3, 10, 30, 20)
    assert math.isclose(math.sqrt(a["m2"] / (a["count"] - 1)), 10)
    assert stats["b"]["count"] == 1
    assert store.stats(15, INF).keys() == {"a", "b"} and store.stats(15, INF)["a"]["count"] == 1


def test_find_rising_and_falling():
    store = make_store(evt("X", "error", 10, dur=50), evt("X", "other", 20, dur=1), evt("X", "error", 30, dur=5))
    matcher = make_wildcard_matcher("err")

    assert store.find(matcher, RISING, -INF, INF, "first") == 10
    assert store.find(matcher, RISING, -INF, INF, "last") == 30
    assert store.find(matcher, FALLING, -INF, INF, "first") == 35
    assert store.find(matcher, FALLING, -INF, INF, "last") == 60
    assert store.find(matcher, RISING, 11, 29, "last") is None
    assert store.find(matcher, FALLING, 40, 70, "first") == 60


def test_bounds():
    assert SpanStore().bounds() is None
    assert make_store(evt("X", "a", 30, dur=1), evt("X", "a", 10, dur=1)).bounds() == (10, 30)


def test_retention_drops_old_spans():
    store = make_store(*(evt("X", "a", ts, dur=1) for ts in range(100)), retention_us=10)

    first, last = store.bounds()

    assert last == 99
    # trimming happens in batches, but never keeps more than ~10% expired spans
    assert first >= 99 - 10 - len(store) // 10
    assert len(store) < 100


def test_query_leaves_out_old_open_spans():
    store = SpanStore(open_history_us=100)
    store.add(evt("B", "stale", 10, tid=1))
    store.add(evt("B", "recent", 950, tid=2))
    store.add(evt("B", "a", 900, tid=3))
    store.add(evt("E", "a", 1000, tid=3))

    # 'stale' began more than 100 before the newest event (1000)
    assert spans_of(store) == [("a", 900, 1000), ("recent", 950, None)]
    assert spans_of(store, 990, 1000) == [("a", 900, 1000), ("recent", 950, None)]


def test_old_closed_spans_stay_in_query():
    store = make_store(evt("B", "long", 10), evt("E", "long", 1000), retention_us=10_000)
    store.open_history_us = 100

    assert spans_of(store, 990, 1000) == [("long", 10, 1000)]
