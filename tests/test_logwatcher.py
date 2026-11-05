#!/usr/bin/env python3

import asyncio
import json
import sys
from pathlib import Path

import pytest

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


@pytest.mark.skipif(sys.platform == "win32", reason="an open file can not be deleted on Windows")
def test_tailer_stops_when_its_file_is_deleted(tmp_path, monkeypatch):
    monkeypatch.setattr("timelens.logwatcher.DELETED_CHECK_POLLS", 1)
    path = tmp_path / "gone.vson"
    write_log(path, 3, 1_000)
    lines = []

    async def callback(line, _):
        lines.append(line)

    async def run():
        watcher = LogWatcher(tmp_path, callback)
        task = asyncio.create_task(watcher._tail_file(path))
        await asyncio.sleep(0.3)
        assert not task.done()      # at the end of the file, waiting for more
        path.unlink()
        await asyncio.wait_for(task, 2)

    asyncio.run(run())
    assert len(lines) == 3


# glob gives the files in the form the folder was given (relative here, without a drive on Windows for '/tmp/...'),
# watchfiles reports them as absolute paths: that is the same file, and it must be tailed once, not twice.
def test_a_file_is_tailed_once_when_the_folder_is_not_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = tmp_path / "logs"
    folder.mkdir()
    path = folder / "app.vson"
    write_log(path, 3, 1_000)
    lines = []

    async def callback(line, _):
        lines.append(line)

    async def run():
        watcher = LogWatcher(Path("logs"), callback)
        await watcher.start()
        await asyncio.sleep(0.5)    # the existing file is tailed, and the folder is watched
        with path.open("a", encoding="utf8", newline="\n") as f:
            f.write(json.dumps({"name": "late", "ph": "B", "ts": 5_000}) + ",\n")
        await asyncio.sleep(3)      # watchfiles reports the change after its debounce of 1.6 seconds
        await watcher.stop()

    asyncio.run(run())
    assert len(lines) == 4
    assert len(set(lines)) == 4
