#!/usr/bin/env python3

import asyncio
from collections import namedtuple

from timelens.names import Names
from timelens.summary import Summarizer
from timelens.system_monitor import SystemMonitor, cpu_temperature, interval_from_env, sample
from timelens.vson import parse_line

Reading = namedtuple("Reading", "label current high critical")


def test_cpu_temperature_takes_the_hottest_reading_of_the_first_cpu_sensor():
    sensors = {
        "nvme": [Reading("Composite", 70.0, None, None)],
        "acpitz": [Reading("", 30.0, None, None)],
        "coretemp": [Reading("Package id 0", 55.0, 80, 100), Reading("Core 0", 52.0, 80, 100)],
    }
    assert cpu_temperature(sensors) == 55.0
    assert cpu_temperature({"nvme": [Reading("Composite", 70.0, None, None)]}) is None
    assert cpu_temperature({}) is None


def test_interval_from_env():
    assert interval_from_env({}) == 1.0
    assert interval_from_env({"TIMELENS_SYSTEM_INTERVAL": "0.5"}) == 0.5
    assert interval_from_env({"TIMELENS_SYSTEM_INTERVAL": "0"}) == 0
    assert interval_from_env({"TIMELENS_SYSTEM_INTERVAL": "fast"}) == 1.0


def test_sample_has_the_cpu_and_ram_usage():
    values = sample(12.5)
    assert values["cpu_percent"] == 12.5
    assert 0 <= values["ram_percent"] <= 100
    assert set(values) <= {"cpu_percent", "ram_percent", "cpu_temp_c"}


def test_writes_lines_the_server_reads(tmp_path):
    async def run():
        monitor = SystemMonitor(tmp_path, interval_s=0.01)
        await monitor.start()
        await asyncio.sleep(0.1)
        await monitor.stop()
        return monitor.path

    path = asyncio.run(run())
    events = [parse_line(line) for line in path.read_text(encoding="utf8").splitlines()]

    names = Names()
    assert names.add(events[0]) is not None and names.processes[events[0]["pid"]] == "timelens server"

    counters = events[1:]
    assert len(counters) >= 2
    assert all(e["ph"] == "C" and e["name"] == "system" and "cpu_percent" in e["args"] for e in counters)
    assert [e["ts"] for e in counters] == sorted(e["ts"] for e in counters)

    # the summary reads them as counters, not spans
    summarizer = Summarizer()
    summarizer.read_file(path)
    summarizer.finish()
    assert summarizer.counter_events == len(counters) and summarizer.skipped_lines == 0
    assert {(r["series"], r["process"]) for r in summarizer.counter_rows()} >= {("cpu_percent", "timelens server"), ("ram_percent", "timelens server")}


def test_interval_zero_writes_nothing(tmp_path):
    async def run():
        monitor = SystemMonitor(tmp_path, interval_s=0)
        await monitor.start()
        await monitor.stop()
        return monitor.path

    assert not asyncio.run(run()).exists()
