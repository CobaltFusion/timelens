#!/usr/bin/env python3

from timelens.event_store import EventStore


def make_store(*timestamps, retention_us=1_000_000):
    store = EventStore(retention_us=retention_us)
    for ts in timestamps:
        store.add({"ts": ts})
    return store


def timestamps(events):
    return [evt["ts"] for evt in events]


def test_out_of_order_events_are_sorted():
    store = make_store(10, 30, 20, 5, 30)

    events, truncated = store.query(float("-inf"), float("inf"))

    assert timestamps(events) == [5, 10, 20, 30, 30]
    assert not truncated


def test_query_bounds_are_inclusive():
    store = make_store(10, 20, 30, 40)

    events, _ = store.query(20, 30)

    assert timestamps(events) == [20, 30]


def test_query_outside_range_is_empty():
    store = make_store(10, 20)

    events, truncated = store.query(100, 200)

    assert events == []
    assert not truncated


def test_limit_keeps_newest_events():
    store = make_store(10, 20, 30, 40)

    events, truncated = store.query(0, 100, limit=2)

    assert timestamps(events) == [30, 40]
    assert truncated


def test_bounds():
    assert EventStore().bounds() is None
    assert make_store(30, 10, 20).bounds() == (10, 30)


def test_retention_drops_old_events():
    store = make_store(*range(0, 100), retention_us=10)

    first, last = store.bounds()

    assert last == 99
    # trimming happens in batches, but never keeps more than ~10% expired events
    assert first >= 99 - 10 - len(store) // 10
    assert len(store) < 100
