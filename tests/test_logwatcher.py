#!/usr/bin/env python3

import json

from timelens.logwatcher import TAIL_STEP_BYTES, LogWatcher


# Writes 'count' events, 'step_us' apart, with names padded to make the file big.
def write_log(path, count, step_us):
    with path.open("w", encoding="utf8", newline="\n") as f:
        for i in range(count):
            f.write(json.dumps({"name": f"é_{i}" + "x" * 100, "ph": "B", "ts": i * step_us}) + ",\n")


def ts_at(path, offset):
    with path.open("rb") as f:
        f.seek(offset)
        return json.loads(f.readline().rstrip(b",\n"))["ts"]


def test_small_file_is_read_from_the_start(tmp_path):
    path = tmp_path / "small.vson"
    write_log(path, 100, 1_000_000)
    assert LogWatcher(tmp_path, None, history_us=1)._tail_offset(path) == 0


def test_reads_back_to_the_history(tmp_path):
    path = tmp_path / "big.vson"
    write_log(path, 100_000, 1_000)     # ~12MB, 100s
    history_us = 30_000_000
    offset = LogWatcher(tmp_path, None, history_us=history_us)._tail_offset(path)

    newest_us = 99_999 * 1_000
    assert offset > 0
    assert ts_at(path, offset) <= newest_us - history_us

    # at most one step further back than needed
    size = path.stat().st_size
    needed = size * history_us // newest_us
    assert size - offset <= needed + TAIL_STEP_BYTES


def test_whole_file_newer_than_history(tmp_path):
    path = tmp_path / "big.vson"
    write_log(path, 30_000, 1_000)      # ~3.5MB, 30s
    assert LogWatcher(tmp_path, None, history_us=60_000_000)._tail_offset(path) == 0


def test_offset_is_at_a_line_start(tmp_path):
    path = tmp_path / "big.vson"
    write_log(path, 50_000, 1_000)
    offset = LogWatcher(tmp_path, None, history_us=5_000_000)._tail_offset(path)
    with path.open("rb") as f:
        f.seek(offset - 1)
        assert f.read(1) == b"\n"
