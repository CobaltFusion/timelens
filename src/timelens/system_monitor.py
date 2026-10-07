#!/usr/bin/env python3
"""
Logs the cpu usage, ram usage and cpu temperature of the machine of the server, as telemetry.

Every sample is a counter event ('ph': 'C') in a '*.vson' file in the folder the server watches, so the
server reads its own samples like those of any other program:

    { "name": "system", "ph": "C", "pid": 1234, "tid": 0, "ts": 6383938378031,
      "args": {"cpu_percent": 12.5, "ram_percent": 41.0, "cpu_temp_c": 54.0} },

'cpu_temp_c' is left out when the temperature can not be read (on Windows psutil can not read it).
The 'ts' is from the same clock as std::chrono::steady_clock, in microseconds, like the other programs.

The interval is 'TIMELENS_SYSTEM_INTERVAL' seconds (default 1), 0 turns the logging off.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path

import psutil

logger = logging.getLogger(__name__)

INTERVAL_ENV = "TIMELENS_SYSTEM_INTERVAL"
DEFAULT_INTERVAL_S = 1.0

COUNTER_NAME = "system"
PROCESS_NAME = "timelens server"

# The sensors of the cpu, by the name psutil gives them, the first one that is there is used.
CPU_SENSORS = ("coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "soc_thermal", "acpitz")


def timestamp_us():
    """Microseconds of the monotonic clock, CLOCK_MONOTONIC on Linux and QueryPerformanceCounter on Windows."""
    return time.perf_counter_ns() // 1_000


def interval_from_env(environ=os.environ):
    """The interval in seconds, 0 when the logging is off."""
    text = environ.get(INTERVAL_ENV)
    if text is None or text.strip() == "":
        return DEFAULT_INTERVAL_S
    try:
        interval = float(text)
    except ValueError:
        logger.warning("%s is not a number: %r, using %g s", INTERVAL_ENV, text, DEFAULT_INTERVAL_S)
        return DEFAULT_INTERVAL_S
    return max(interval, 0.0)


def cpu_temperature(sensors):
    """
    The temperature of the cpu (°C) from the result of 'psutil.sensors_temperatures()', None if there is none.
    The hottest reading of the first known cpu sensor is used, like 'Package id 0' of 'coretemp'.
    """
    for name in CPU_SENSORS:
        readings = [reading.current for reading in sensors.get(name, ()) if reading.current is not None]
        if readings:
            return max(readings)
    return None


def read_cpu_temperature():
    read = getattr(psutil, "sensors_temperatures", None)    # not on Windows and macOS
    if read is None:
        return None
    try:
        return cpu_temperature(read())
    except (OSError, RuntimeError):
        return None


def sample(cpu_percent):
    """The values of one sample, see the module docstring, with the cpu usage measured by the caller."""
    values = {
        "cpu_percent": cpu_percent,
        "ram_percent": psutil.virtual_memory().percent,
    }
    temperature = read_cpu_temperature()
    if temperature is not None:
        values["cpu_temp_c"] = round(temperature, 1)
    return values


def counter_event(values, ts, pid):
    return {"name": COUNTER_NAME, "ph": "C", "pid": pid, "tid": 0, "ts": ts, "args": values}


def process_name_event(pid):
    return {"args": {"name": PROCESS_NAME}, "name": "process_name", "cat": "__metadata", "ph": "M",
            "pid": pid, "tid": 0, "ts": 0}


def line_of(evt):
    return json.dumps(evt) + ",\n"


class SystemMonitor:
    """Writes a sample every 'interval_s' seconds to 'telemetry_timelens_<pid>.vson' in 'directory'."""

    def __init__(self, directory, interval_s=DEFAULT_INTERVAL_S):
        self.pid = os.getpid()
        self.path = Path(directory) / f"telemetry_timelens_{self.pid}.vson"
        self.interval_s = interval_s
        self._task = None
        self._file = None

    async def start(self):
        if self._task is not None or self.interval_s <= 0:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._file = self.path.open("a", encoding="utf8", newline="\n")
        except OSError:
            logger.exception("Can not write the system telemetry to %s", self.path)
            return

        psutil.cpu_percent(interval=None)       # the first call has nothing to measure from, it returns 0
        self._write(process_name_event(self.pid))
        logger.warning("System telemetry every %g s to %s", self.interval_s, self.path)
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._file is not None:
            self._file.close()
            self._file = None

    async def _run(self):
        next_time = time.monotonic()
        while True:
            next_time += self.interval_s
            await asyncio.sleep(max(next_time - time.monotonic(), 0))
            try:
                # psutil measures the cpu usage since the previous call of the same thread, so always on this one
                cpu_percent = psutil.cpu_percent(interval=None)
                # reading the sensors can take a few ms, not on the event loop
                values = await asyncio.to_thread(sample, cpu_percent)
                self._write(counter_event(values, timestamp_us(), self.pid))
            except Exception:
                logger.exception("Failed to log the system telemetry")

    def _write(self, evt):
        self._file.write(line_of(evt))
        self._file.flush()      # whole lines, so the watcher never reads half an event
