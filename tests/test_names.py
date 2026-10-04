#!/usr/bin/env python3

import asyncio
import json
import math
import random

import pytest

from timelens.logwatcher import MAX_HEAD_LINES, LogWatcher
from timelens.names import Names, is_metadata
from timelens.span_store import SpanStore
from timelens.summary import Pairer, Summarizer

PROCESS_NAME = {"args": {"name": "pylon_gevmgr"}, "name": "process_name", "cat": "__metadata", "ph": "M", "pid": 1028534, "tid": 0, "ts": 0}
THREAD_NAME = {"args": {"name": "worker 1"}, "name": "thread_name", "cat": "__metadata", "ph": "M", "pid": 1028534, "tid": 7, "ts": 0}


def test_is_metadata():
    assert is_metadata(PROCESS_NAME)
    assert is_metadata({"ph": "M", "name": "process_sort_index"})
    assert is_metadata({"cat": "__metadata", "name": "x"})
    assert not is_metadata({"ph": "B", "name": "process_name", "cat": "loop"})      # only the phase and category count
    assert not is_metadata({"name": "x"})


def test_process_and_thread_names():
    names = Names()

    assert names.add(PROCESS_NAME) == ("process", 1028534, None, "pylon_gevmgr")
    assert names.add(THREAD_NAME) == ("thread", 1028534, 7, "worker 1")
    assert names.processes == {1028534: "pylon_gevmgr"}
    assert names.threads == {(1028534, 7): "worker 1"}


def test_the_same_name_again_is_not_a_change_a_new_one_is():
    names = Names()
    names.add(THREAD_NAME)

    assert names.add(THREAD_NAME) is None
    assert names.add({**THREAD_NAME, "args": {"name": "worker 2"}}) == ("thread", 1028534, 7, "worker 2")
    assert names.threads == {(1028534, 7): "worker 2"}


def test_threads_of_other_processes_have_their_own_names():
    names = Names()
    names.add(THREAD_NAME)
    names.add({**THREAD_NAME, "pid": 2})

    assert len(names.threads) == 2


@pytest.mark.parametrize("evt", [
    {"ph": "M", "name": "process_sort_index", "pid": 1, "args": {"sort_index": 3}},    # other metadata
    {"ph": "M", "name": "process_name", "pid": 1},                                   # no args
    {"ph": "M", "name": "process_name", "pid": 1, "args": {"name": ""}},
    {"ph": "M", "name": "process_name", "pid": 1, "args": {"name": 5}},
    {"ph": "M", "name": "thread_name", "pid": 1, "tid": 1, "args": "text"},
])
def test_metadata_without_a_name_is_ignored(evt):
    names = Names()
    assert names.add(evt) is None
    assert names.processes == {} and names.threads == {}


def test_snapshot_and_message_for_the_clients():
    names = Names()
    names.add(PROCESS_NAME)
    names.add(THREAD_NAME)

    assert names.snapshot() == {"type": "names", "processes": [[1028534, "pylon_gevmgr"]], "threads": [[1028534, 7, "worker 1"]]}
    assert Names.message(("thread", 1028534, 7, "worker 1")) == {"type": "name", "kind": "thread", "pid": 1028534, "tid": 7, "name": "worker 1"}
    json.dumps(names.snapshot())


# ---- a metadata event is not an event

def test_the_span_store_makes_no_span_of_metadata():
    store = SpanStore()
    span, edges = store.add({**PROCESS_NAME, "source": "a.vson"})

    assert (span, edges) == (None, [])
    assert len(store) == 0
    assert store.bounds() is None
    assert store.query(-math.inf, math.inf)[0] == []


def test_the_summary_ignores_metadata():
    summarizer = Summarizer()
    for e in (PROCESS_NAME, THREAD_NAME, {"ph": "X", "name": "a", "ts": 5, "dur": 10, "pid": 1, "tid": 1}):
        summarizer.add_event(dict(e))
    summarizer.finish()

    assert [r["name"] for r in summarizer.rows()] == ["a"]
    assert summarizer.events == 1


def test_the_summary_and_the_span_store_still_pair_the_same_with_metadata_in_between():
    rng = random.Random(3)
    events = []
    for i in range(1500):
        ph = rng.choice("BEXM")
        e = {"ph": ph, "name": rng.choice(["a", "b", "process_name", "thread_name"]), "ts": i * 10, "pid": rng.choice([1, 2]),
             "tid": rng.choice([1, 2]), "source": "x.vson", "args": {"name": "n"}}
        if ph == "X":
            e["dur"] = rng.randrange(100)
        events.append(e)

    store = SpanStore(retention_us=float("inf"))
    for e in events:
        store.add(dict(e))
    spans, _ = store.query(-math.inf, math.inf)
    pairer = Pairer()
    paired = [s for s in (pairer.add(dict(e)) for e in events) if s is not None]

    assert sorted(paired) == sorted((s["name"], s["pid"], s["tid"], s["ts"], s["end"]) for s in spans if s["end"] is not None)
    assert all(s["name"] != "x" for s in spans)


# ---- the start of a big file

def write_lines(path, events):
    lines = [json.dumps(e) + ",\n" for e in events]
    lines[0] = "[" + lines[0]
    path.write_text("".join(lines), encoding="utf8", newline="\n")


def event(i):
    return {"name": f"event_{i}", "ph": "X", "pid": 1, "tid": 7, "ts": i * 1000, "dur": 5}


def test_metadata_head_is_the_metadata_before_the_first_event(tmp_path):
    path = tmp_path / "a.vson"
    write_lines(path, [PROCESS_NAME, THREAD_NAME, event(1), {**THREAD_NAME, "tid": 8}])

    head = LogWatcher._metadata_head(path)

    assert [json.loads(line.lstrip("[").rstrip(",\n"))["name"] for line in head] == ["process_name", "thread_name"]


def test_metadata_head_without_metadata_or_with_a_bad_line(tmp_path):
    path = tmp_path / "a.vson"
    write_lines(path, [event(1), PROCESS_NAME])
    assert LogWatcher._metadata_head(path) == []

    path.write_text("{broken\n" + json.dumps(PROCESS_NAME) + ",\n", encoding="utf8", newline="\n")
    assert LogWatcher._metadata_head(path) == []

    path.write_text("", encoding="utf8")
    assert LogWatcher._metadata_head(path) == []


def test_metadata_head_is_limited(tmp_path):
    path = tmp_path / "a.vson"
    write_lines(path, [{**THREAD_NAME, "tid": i} for i in range(MAX_HEAD_LINES + 50)])
    assert len(LogWatcher._metadata_head(path)) == MAX_HEAD_LINES


def test_a_big_file_that_is_read_from_the_end_still_delivers_its_names(tmp_path):
    path = tmp_path / "big.vson"
    write_lines(path, [PROCESS_NAME, THREAD_NAME] + [event(i) for i in range(30_000)])      # more than a step of 1 MB
    received = []

    async def callback(line, source):
        received.append(json.loads(line.lstrip("[").rstrip(",\n")))

    async def run():
        watcher = LogWatcher(tmp_path, callback, history_us=2_000_000)      # the last 2 seconds of 30
        task = asyncio.create_task(watcher._tail_file(path))
        await asyncio.sleep(0.5)
        watcher._stop.set()
        await task

    asyncio.run(run())

    assert [e["name"] for e in received[:2]] == ["process_name", "thread_name"]
    assert received[2]["name"] != "event_0"             # the start of the file was skipped
    assert received[-1]["name"] == "event_29999"        # the end was read
    assert len(received) < 20_000                       # about a 1 MB step before the cut off, not the 30,000 of the file
