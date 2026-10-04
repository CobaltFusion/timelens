#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path

from watchfiles import awatch

from timelens.names import is_metadata
from timelens.vson import parse_line

logger = logging.getLogger(__name__)

# An existing file is read from about 'history_us' before its newest event, the start is
# found by stepping back from the end of the file this many bytes at a time.
TAIL_STEP_BYTES = 1 << 20

# Same as the retention of the span store.
DEFAULT_HISTORY_US = 30 * 60 * 1_000_000

# At most this many lines at the start of a file are looked at for metadata, see '_metadata_head()'.
MAX_HEAD_LINES = 1000


# The 'ts' of a line of a log file, None if it has none or is not a complete event.
def _timestamp_of(line):
    line = line.strip()
    if line.startswith(b"["):
        line = line[1:]
    if line.endswith(b","):
        line = line[:-1]
    try:
        evt = json.loads(line)
    except ValueError:
        return None
    ts = evt.get("ts") if isinstance(evt, dict) else None
    return ts if isinstance(ts, (int, float)) else None


# (offset, ts) of the first complete line at or after 'offset' that has a 'ts', or None.
def _first_timestamp(f, offset):
    f.seek(offset)
    if offset > 0:
        f.readline()    # skip the partial line
    while True:
        line_offset = f.tell()
        line = f.readline()
        if not line:
            return None
        ts = _timestamp_of(line)
        if ts is not None:
            return line_offset, ts


# The 'ts' of the last line at or after 'offset' that has one, or None.
def _last_timestamp(f, offset):
    f.seek(offset)
    if offset > 0:
        f.readline()    # skip the partial line
    last = None
    for line in f:
        ts = _timestamp_of(line)
        if ts is not None:
            last = ts
    return last


class LogWatcher:
    def __init__(self, path, callback, history_us=DEFAULT_HISTORY_US):
        self.path = Path(path)
        self.callback = callback
        self.history_us = history_us

        self._runner: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._start_lock = asyncio.Lock()

        # Tracks active tail tasks so we don't tail the same file twice.
        self._tailers: dict[Path, asyncio.Task] = {}

    async def start(self):
        async with self._start_lock:
            if self._runner is not None:
                return

            self._stop.clear()
            self._runner = asyncio.create_task(self._run())

    async def stop(self):
        async with self._start_lock:
            if self._runner is None:
                return

            self._stop.set()
            self._runner.cancel()

            with contextlib.suppress(asyncio.CancelledError):
                await self._runner

            self._runner = None
            self._tailers.clear()

    async def restart(self):
        await self.stop()
        await self.start()

    async def _run(self):
        async with asyncio.TaskGroup() as tg:
            #
            # Tail existing files first.
            #
            for file in self.path.glob("*.vson"):
                self._start_tailer(file, tg)

            #
            # Watch for new/modified files.
            #
            async for changes in awatch(self.path, stop_event=self._stop):
                for _, file in changes:
                    file = Path(file)

                    if file.suffix != ".vson":
                        continue

                    self._start_tailer(file, tg)

                if self._stop.is_set():
                    break

    def _start_tailer(self, path, tg: asyncio.TaskGroup):
        existing = self._tailers.get(path)

        if existing is not None and not existing.done():
            return

        task = tg.create_task(self._tail_file(path))

        def _cleanup(_):
            self._tailers.pop(path, None)

        task.add_done_callback(_cleanup)
        self._tailers[path] = task

    # The offset of the line to start reading 'path' from: the first line of the 'TAIL_STEP_BYTES'
    # step back from the end where the events are 'history_us' older than the newest event.
    # 0 for small files, or when the whole file is newer.
    def _tail_offset(self, path):
        with path.open("rb") as f:
            size = f.seek(0, 2)
            if size <= TAIL_STEP_BYTES:
                return 0

            newest_us = _last_timestamp(f, size - TAIL_STEP_BYTES)
            if newest_us is None:
                return 0
            cutoff_us = newest_us - self.history_us

            offset = size
            while offset > 0:
                offset = max(0, offset - TAIL_STEP_BYTES)
                found = _first_timestamp(f, offset)
                if found is not None and found[1] <= cutoff_us:
                    return found[0]
            return 0

    # The metadata lines (names of the process and its threads) a program writes at the start of its file, up
    # to the first line that is an event. They are needed when the start of a big file is skipped.
    @staticmethod
    def _metadata_head(path):
        lines = []
        with path.open("r", encoding="utf8", errors="replace") as f:
            for _ in range(MAX_HEAD_LINES):
                line = f.readline()
                if not line:
                    break
                try:
                    evt = parse_line(line)
                except ValueError:
                    break
                if evt is None:
                    continue    # a bracket or an empty line
                if not is_metadata(evt):
                    break
                lines.append(line)
        return lines

    async def _tail_file(self, path):
        try:
            offset = self._tail_offset(path)
            if offset > 0:
                logger.info("Skipping the first %d bytes of %s", offset, path)
                # the skipped part has the names of the process and threads, keep those
                for line in self._metadata_head(path):
                    await self.callback(line, str(path))

            with path.open("r", encoding="utf8") as f:
                # 'offset' is at the start of a line, so it is also a valid position in text mode
                f.seek(offset)

                while not self._stop.is_set():
                    line = f.readline()

                    if not line:
                        await asyncio.sleep(0.1)
                        continue

                    try:
                        await self.callback(line, str(path))
                    except Exception:
                        logger.exception(
                            "Exception in LogWatcher callback for %s",
                            path,
                        )

        except asyncio.CancelledError:
            raise

        except Exception:
            logger.exception("Failed to tail %s", path)
