#!/usr/bin/env python3

import asyncio
from pathlib import Path

import pytest

from timelens.logwatcher import LogWatcher


@pytest.mark.asyncio
async def test_logwatcher_receives_new_lines(tmp_path: Path):
    received = asyncio.Queue()

    async def callback(line: str, path: str):
        await received.put(
            (
                line.rstrip("\n"),
                Path(path).name,
            )
        )

    watcher = LogWatcher(tmp_path, callback)

    await watcher.start()

    try:
        logfile = tmp_path / "example.vson"

        #
        # Create the file after starting the watcher.
        #
        with logfile.open("w", encoding="utf8") as f:
            f.write("first line\n")
            f.flush()

        #
        # Wait for the watcher callback.
        #
        item = await asyncio.wait_for(
            received.get(),
            timeout=2.0,
        )

        assert item == (
            "first line",
            "example.vson",
        )

        #
        # Append another line.
        #
        with logfile.open("a", encoding="utf8") as f:
            f.write("second line\n")
            f.flush()

        item = await asyncio.wait_for(
            received.get(),
            timeout=2.0,
        )

        assert item == (
            "second line",
            "example.vson",
        )

    finally:
        await watcher.stop()
