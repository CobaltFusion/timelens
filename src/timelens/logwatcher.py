from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from watchfiles import awatch

logger = logging.getLogger(__name__)


class LogWatcher:
    def __init__(self, path, callback):
        self.path = Path(path)
        self.callback = callback

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

    async def _tail_file(self, path):
        try:
            with path.open("r", encoding="utf8") as f:

                # Uncomment if you only want new lines.
                # f.seek(0, 2)

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
