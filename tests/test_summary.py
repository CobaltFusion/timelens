#!/usr/bin/env python3

import io
import json
import math
import random

import pytest

from timelens.span_store import SpanStore
from timelens.summary import Pairer, Summarizer, main, percentile
from timelens.vson import find_log_files, parse_line


def evt(ph, name, ts, pid=1, tid=1, **extra):
    return {"ph": ph, "name": name, "ts": ts, "pid": pid, "tid": tid, **extra}


def summarize(*events, **kwargs):
    summarizer = Summarizer(**kwargs)
    for e in events:
        summarizer.add_event({"source": "a.vson", **e})
    summarizer.finish()
    return summarizer


def row_of(summarizer, name, pid=1, tid=1):
    (row,) = [r for r in summarizer.rows() if (r["name"], r["process"], r["thread"]) == (name, pid, tid)]
    return row


def write_log(path, events):
    # like the files of the server: an array that is not closed, a comma after every event
    lines = [json.dumps(e) + ",\n" for e in events]
    lines[0] = "[" + lines[0]
    path.write_text("".join(lines), encoding="utf8", newline="\n")


def run(*argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    code = main(list(argv), stdout=stdout, stderr=stderr)
    return code, stdout.getvalue(), stderr.getvalue()


# ---- the files

@pytest.mark.parametrize("line, expected", [
    ('{"name": "a", "ts": 1},\n', {"name": "a", "ts": 1}),
    ('[{"name": "a", "ts": 1},\n', {"name": "a", "ts": 1}),         # the first line of a file
    ('{"name": "a", "ts": 1}\n', {"name": "a", "ts": 1}),           # the last one has no comma
    ('{"name": "a", "ts": 1},\r\n', {"name": "a", "ts": 1}),
    ("\n", None), ("   \n", None), ("[\n", None), ("]\n", None),
])
def test_parse_line(line, expected):
    assert parse_line(line) == expected


@pytest.mark.parametrize("line", ["{not json},\n", "[1, 2],\n", '"text",\n', "42,\n"])
def test_parse_line_refuses_what_is_not_an_event(line):
    with pytest.raises(ValueError):
        parse_line(line)


def test_find_log_files(tmp_path):
    (tmp_path / "b.vson").write_text("x")
    (tmp_path / "a.vson").write_text("x")
    (tmp_path / "notes.txt").write_text("x")
    other = tmp_path / "sub"
    other.mkdir()
    (other / "c.vson").write_text("x")

    assert find_log_files([tmp_path]) == [tmp_path / "a.vson", tmp_path / "b.vson"]
    assert find_log_files([tmp_path / "b.vson", other]) == [tmp_path / "b.vson", other / "c.vson"]
    with pytest.raises(FileNotFoundError):
        find_log_files([tmp_path / "missing.vson"])


# ---- grouping and statistics

def test_groups_are_name_pid_and_tid():
    summarizer = summarize(
        evt("B", "a", 0), evt("E", "a", 10),                             # a, 1, 1
        evt("B", "a", 20), evt("E", "a", 50),                            # a, 1, 1 again
        evt("B", "a", 0, tid=2), evt("E", "a", 5, tid=2),                # another tid
        evt("B", "a", 0, pid=2), evt("E", "a", 7, pid=2),                # another pid
        evt("B", "b", 0), evt("E", "b", 3),                              # another name
    )

    assert len(summarizer.rows()) == 4 + 0
    assert row_of(summarizer, "a")["count"] == 2
    assert row_of(summarizer, "a", tid=2)["count"] == 1
    assert row_of(summarizer, "a", pid=2)["count"] == 1
    assert row_of(summarizer, "b")["count"] == 1


def test_statistics_of_a_group():
    summarizer = summarize(*[e for i, d in enumerate([10, 20, 30, 40]) for e in (evt("B", "a", i * 100), evt("E", "a", i * 100 + d))])
    row = row_of(summarizer, "a")

    assert row["count"] == 4
    assert row["total_us"] == 100
    assert (row["min_us"], row["max_us"], row["mean_us"]) == (10, 40, 25)
    assert row["p50_us"] == 25
    assert row["p95_us"] == pytest.approx(38.5)
    assert row["stddev_us"] == pytest.approx(math.sqrt(500 / 3))    # sample standard deviation
    assert row["open"] == 0


def test_single_span_has_no_standard_deviation():
    row = row_of(summarize(evt("B", "a", 0), evt("E", "a", 10)), "a")
    assert row["stddev_us"] is None
    assert row["p99_us"] == 10


def test_complete_events_and_nested_events():
    summarizer = summarize(
        evt("X", "a", 0, dur=50),
        evt("B", "n", 100), evt("B", "n", 110), evt("E", "n", 120), evt("E", "n", 150),    # the inner one ends first
    )

    assert row_of(summarizer, "a")["total_us"] == 50
    n = row_of(summarizer, "n")
    assert (n["count"], n["min_us"], n["max_us"]) == (2, 10, 50)


def test_end_without_name_closes_the_innermost_span():
    summarizer = summarize(evt("B", "a", 0), evt("B", "b", 10), evt("E", "", 15))
    assert row_of(summarizer, "b")["count"] == 1
    assert row_of(summarizer, "a")["count"] == 0 and row_of(summarizer, "a")["open"] == 1


def test_open_spans_and_unmatched_ends_are_counted_not_summarized():
    summarizer = summarize(
        evt("B", "a", 0),                       # never closed
        evt("E", "c", 5),                       # was never opened
        {"ph": "B", "name": "d"},               # no time
        evt("B", "e", "soon"),                  # no numeric time
    )

    assert summarizer.unmatched_ends == 1
    assert summarizer.events_without_time == 2
    assert summarizer.events == 2
    row = row_of(summarizer, "a")
    assert (row["count"], row["open"], row["total_us"], row["p50_us"]) == (1 - 1, 1, None, None)


def test_an_end_before_its_begin_has_no_negative_duration():
    assert row_of(summarize(evt("B", "a", 100), evt("E", "a", 90)), "a")["total_us"] == 0


def test_without_percentiles():
    row = row_of(summarize(evt("X", "a", 0, dur=5), keep_durations=False), "a")
    assert row["p50_us"] is None and row["total_us"] == 5


def test_percentile():
    assert percentile([], 50) is None
    assert percentile([7], 99) == 7
    assert percentile([1, 2, 3, 4], 0) == 1
    assert percentile([1, 2, 3, 4], 100) == 4
    assert percentile([1, 2, 3, 4], 50) == 2.5
    assert percentile([10, 20], 25) == 12.5


def test_pairs_the_same_spans_as_the_span_store():
    rng = random.Random(7)
    names = ["a", "b", "c", ""]
    events = []
    for i in range(3000):
        ph = rng.choice("BBEEXiC")
        e = evt(ph, rng.choice(names), i * 10 + rng.randrange(10), pid=rng.choice([1, 2]), tid=rng.choice([1, 2, 3]),
                source=rng.choice(["x.vson", "y.vson"]))
        if ph == "X":
            e["dur"] = rng.randrange(1000)
        events.append(e)

    store = SpanStore(retention_us=float("inf"))
    for e in events:
        store.add(dict(e))
    spans, _ = store.query(-math.inf, math.inf)
    expected = sorted((s["name"], s["pid"], s["tid"], s["ts"], s["end"]) for s in spans if s["end"] is not None)
    expected_open = sorted((s["name"], s["pid"], s["tid"]) for s in spans if s["end"] is None)

    pairer = Pairer()
    paired = [span for span in (pairer.add(dict(e)) for e in events) if span is not None]

    assert sorted(paired) == expected
    assert sorted(pairer.open_spans()) == expected_open


# ---- the command line

def make_logs(tmp_path):
    write_log(tmp_path / "one.vson", [
        evt("B", "load", 0, pid=10, tid=1), evt("E", "load", 100, pid=10, tid=1),
        evt("B", "load", 200, pid=10, tid=1), evt("E", "load", 500, pid=10, tid=1),
        evt("X", "save", 0, pid=10, tid=2, dur=2000),
        evt("B", "stuck", 0, pid=10, tid=2),
    ])
    (tmp_path / "bad.vson").write_text('{broken,\n' + json.dumps(evt("X", "other", 0, pid=11, dur=1)) + "\n", encoding="utf8", newline="\n")
    return tmp_path


def test_files_are_not_mixed_up(tmp_path):
    # the same pid and tid in two files are two threads, an end in another file does not close a begin
    write_log(tmp_path / "a.vson", [evt("B", "x", 0)])
    write_log(tmp_path / "b.vson", [evt("E", "x", 10)])
    summarizer = Summarizer()
    for path in find_log_files([tmp_path]):
        summarizer.read_file(path)
    summarizer.finish()

    assert summarizer.unmatched_ends == 1
    assert row_of(summarizer, "x")["open"] == 1


def test_table(tmp_path):
    code, out, err = run(str(make_logs(tmp_path)), "--quiet")
    lines = out.splitlines()

    assert code == 0 and err == ""
    assert lines[0].split() == ["name", "process", "thread", "count", "total", "min", "mean", "p50", "p95", "p99", "max", "stddev", "open"]
    by_name = {line.split()[0]: line.split() for line in lines[2:] if line and not line[0].isdigit()}
    assert by_name["save"][3:5] == ["1", "2.000"]               # the total is 2.000 ms
    assert by_name["load"][3] == "2" and by_name["load"][-1] == "0"
    assert by_name["stuck"][-1] == "1"
    assert "7 events from 2 file(s) in 4 groups" in out
    assert "1 lines skipped" in out
    assert [line.split()[0] for line in lines[2:6]] == ["save", "load", "other", "stuck"]     # the biggest total first


def test_sort_and_top(tmp_path):
    logs = str(make_logs(tmp_path))
    names = lambda *argv: [line.split()[0] for line in run(logs, "--quiet", *argv)[1].splitlines()[2:] if line and line.split()[0] in ("save", "load", "other", "stuck")]

    assert names("--sort", "name") == ["load", "other", "save", "stuck"]
    assert names("--sort", "count")[0] == "load"
    assert names("--top", "2") == ["save", "load"]
    assert "2 shown" in run(logs, "--quiet", "--top", "2")[1]


def test_name_filter_uses_the_wildcards_of_the_trigger_word(tmp_path):
    logs = str(make_logs(tmp_path))
    assert [r["name"] for r in json.loads(run(logs, "--format", "json", "--name", "LOA")[1])["groups"]] == ["load"]
    assert [r["name"] for r in json.loads(run(logs, "--format", "json", "--name", "s*e")[1])["groups"]] == ["save"]


def test_csv_and_json(tmp_path):
    logs = str(make_logs(tmp_path))
    code, out, err = run(logs, "--format", "csv", "--sort", "name")
    lines = out.splitlines()

    assert code == 0
    assert lines[0].startswith("name,process,thread,count,total_us,min_us,mean_us,p50_us")
    assert lines[1].split(",")[:6] == ["load", "10", "1", "2", "400", "100"]
    assert "events from 2 file(s)" in err                       # the summary line is not in the data

    data = json.loads(run(logs, "--format", "json")[1])
    assert data["events"] == 7 and data["skipped_lines"] == 1 and data["unmatched_ends"] == 0
    save = [g for g in data["groups"] if g["name"] == "save"][0]
    assert (save["process"], save["thread"], save["count"], save["total_us"]) == (10, 2, 1, 2000)


def test_process_and_thread_names(tmp_path):
    # a name given by a metadata event replaces the number, also when it comes after the events
    write_log(tmp_path / "a.vson", [
        evt("X", "a", 0, pid=10, tid=1, dur=5), evt("X", "a", 0, pid=10, tid=2, dur=5), evt("X", "a", 0, pid=11, tid=1, dur=5),
        {"ph": "M", "cat": "__metadata", "name": "process_name", "pid": 10, "tid": 0, "ts": 0, "args": {"name": "server"}},
        {"ph": "M", "cat": "__metadata", "name": "thread_name", "pid": 10, "tid": 1, "ts": 0, "args": {"name": "main"}},
    ])
    data = json.loads(run(str(tmp_path), "--format", "json", "--sort", "name")[1])

    assert [(g["process"], g["thread"]) for g in data["groups"]] == [(11, 1), ("server", 2), ("server", "main")]
    assert data["events"] == 3


def test_no_percentiles(tmp_path):
    out = run(str(make_logs(tmp_path)), "--no-percentiles")[1]
    assert "p50" not in out and "mean" in out


def test_errors(tmp_path):
    code, out, err = run(str(tmp_path / "missing"))
    assert code == 1 and "no such file or folder" in err

    code, out, err = run(str(tmp_path))      # an empty folder
    assert code == 1 and "no '*.vson' files found" in err


# ---- events of other phases are ignored

OTHER_PHASES = ["C", "i", "I", "b", "e", "n", "P"]


def test_the_pairer_ignores_other_phases():
    pairer = Pairer()

    assert all(pairer.add({"ph": phase, "name": "x", "ts": 5, "pid": 1, "tid": 1}) is None for phase in OTHER_PHASES)
    assert list(pairer.open_spans()) == []          # they do not open a span, an instant is not a begin
    assert pairer.add({"ph": "i", "name": "a", "ts": 7, "pid": 1, "tid": 1, "source": "a"}) is None
    assert pairer.unmatched_ends == 0


def test_the_summary_counts_the_events_that_it_ignores():
    summarizer = summarize(
        evt("B", "a", 0), evt("C", "counter", 3), evt("i", "a", 5), evt("E", "a", 10),
        {"ph": "C", "name": "no time"},
    )

    assert [r["name"] for r in summarizer.rows()] == ["a"]
    assert row_of(summarizer, "a")["total_us"] == 10 and row_of(summarizer, "a")["open"] == 0
    assert summarizer.ignored_events == 3
    assert summarizer.events == 2           # the begin and the end
    assert summarizer.events_without_time == 0


def test_the_command_line_says_how_many_events_were_ignored(tmp_path):
    write_log(tmp_path / "a.vson", [
        evt("B", "load", 0), evt("C", "memory", 10, args={"bytes": 5}), evt("i", "mark", 20),
        evt("E", "load", 100), evt("C", "memory", 110),
    ])

    code, out, err = run(str(tmp_path), "--quiet")
    assert code == 0
    assert "3 events of other types than B, E and X ignored" in out
    assert [line.split()[0] for line in out.splitlines()[2:3]] == ["load"]
    assert "memory" not in out and "mark" not in out.split("events from")[0]       # no group for them

    data = json.loads(run(str(tmp_path), "--format", "json")[1])
    assert data["ignored_events"] == 3 and data["events"] == 2
    assert [g["name"] for g in data["groups"]] == ["load"]

    # nothing ignored: nothing is said
    write_log(tmp_path / "a.vson", [evt("B", "load", 0), evt("E", "load", 100)])
    assert "ignored" not in run(str(tmp_path), "--quiet")[1]
