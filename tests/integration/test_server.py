"""
Integration tests of the server: a real server process that tails a log folder, and a WebSocket client. These are
about how programs write their logs: lines that are written in parts, files that appear later, events that are still
open, and bursts.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
import websockets

from .conftest import wait_for
from .load import line, now_us

pytestmark = pytest.mark.integration


class Client:
    """A WebSocket client of the server: requests with replies, and the spans and triggers it pushes."""

    def __init__(self, url):
        self.url = url
        self.spans = []
        self.triggers = []
        self.replies = {}
        self.next_id = 0

    async def __aenter__(self):
        self.ws = await websockets.connect(self.url, max_size=None)
        self.reader = asyncio.create_task(self._read())
        return self

    async def __aexit__(self, *_):
        self.reader.cancel()
        await self.ws.close()

    async def _read(self):
        async for text in self.ws:
            message = json.loads(text)
            kind = message.get("type")
            if kind == "span":
                self.spans.append(message)
            elif kind == "trigger":
                self.triggers.append(message)
            elif "requestId" in message:
                self.replies.setdefault(message["requestId"], []).append(message)

    async def request(self, action, **fields):
        self.next_id += 1
        request_id = self.next_id
        await self.ws.send(json.dumps({"action": action, "requestId": request_id, **fields}))
        while True:
            replies = self.replies.get(request_id, [])
            if replies and (replies[-1].get("type") != "range" or replies[-1]["done"]):
                return replies
            await asyncio.sleep(0.01)

    async def query(self, start_us=None, end_us=None):
        replies = await self.request("query", startUs=start_us, endUs=end_us)
        return [span for reply in replies for span in reply["spans"]]

    async def until(self, condition, timeout=10.0, message="condition"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if result := condition():
                return result
            await asyncio.sleep(0.02)
        raise AssertionError(f"timed out after {timeout} s waiting for {message}")


def run(coroutine):
    """Runs the test in a thread with an event loop of its own, the main thread can have one of Playwright's."""
    errors = []

    def target():
        try:
            asyncio.run(coroutine)
        except BaseException as error:     # reported in the test, not in the thread
            errors.append(error)

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if errors:
        raise errors[0]


def append(path, text):
    with path.open("a", encoding="utf8", newline="\n") as f:
        f.write(text)
        f.flush()


def complete(name, ts, dur, tid=1, pid=1):
    return line({"name": name, "ph": "X", "pid": pid, "tid": tid, "ts": ts, "dur": dur})


def test_a_line_written_in_two_parts_is_one_event(quiet_server):
    path = quiet_server.log_dir / "parts.vson"

    async def test():
        async with Client(quiet_server.ws_url) as client:
            append(path, complete("first", now_us(), 100))
            await client.until(lambda: any(s["name"] == "first" for s in client.spans), message="the first event")

            # a program that writes a line in two parts, e.g. its buffer was flushed in the middle of the line
            text = complete("split_in_two", now_us(), 200)
            append(path, text[:25])
            await asyncio.sleep(0.5)        # the server reads the first part on its own
            append(path, text[25:])
            append(path, complete("after", now_us(), 100))

            await client.until(lambda: any(s["name"] == "after" for s in client.spans), message="the event after it")
            names = [s["name"] for s in client.spans]
            assert names == ["first", "split_in_two", "after"]

    run(test())


def test_a_file_that_appears_later_is_read(quiet_server):
    async def test():
        async with Client(quiet_server.ws_url) as client:
            append(quiet_server.log_dir / "later.vson", complete("from_a_new_file", now_us(), 100))
            await client.until(lambda: client.spans, message="the event of the new file")
            assert [s["name"] for s in client.spans] == ["from_a_new_file"]

            # and only once, also when more is written
            append(quiet_server.log_dir / "later.vson", complete("second", now_us(), 100))
            await client.until(lambda: len(client.spans) >= 2, message="the second event")
            await asyncio.sleep(0.5)
            assert [s["name"] for s in client.spans] == ["from_a_new_file", "second"]
            assert len(await client.query()) == 2

    run(test())


def test_an_open_event_is_closed_by_its_end(quiet_server):
    path = quiet_server.log_dir / "open.vson"
    begin = now_us()

    async def test():
        async with Client(quiet_server.ws_url) as client:
            append(path, line({"name": "long_job", "ph": "B", "pid": 1, "tid": 7, "ts": begin}))
            await client.until(lambda: client.spans, message="the begin")
            assert client.spans[0]["end"] is None

            # an open event has no duration yet, it is not in the statistics
            stats = (await client.request("stats", startUs=None, endUs=None))[0]["stats"]
            assert "long_job" not in stats

            append(path, line({"name": "long_job", "ph": "E", "pid": 1, "tid": 7, "ts": begin + 5_000}))
            await client.until(lambda: len(client.spans) >= 2, message="the end")
            assert client.spans[1]["id"] == client.spans[0]["id"]
            assert client.spans[1]["end"] == begin + 5_000

            spans = await client.query()
            assert len(spans) == 1 and spans[0]["end"] == begin + 5_000
            stats = (await client.request("stats", startUs=None, endUs=None))[0]["stats"]
            assert stats["long_job"]["count"] == 1 and stats["long_job"]["max"] == 5_000

    run(test())


def test_nested_events_with_the_same_name_close_inside_out(quiet_server):
    path = quiet_server.log_dir / "nested.vson"
    t = now_us()

    async def test():
        async with Client(quiet_server.ws_url) as client:
            for ph, ts in (("B", t), ("B", t + 10), ("E", t + 20), ("E", t + 100)):
                append(path, line({"name": "recurse", "ph": ph, "pid": 1, "tid": 1, "ts": ts}))
            await client.until(lambda: len(client.spans) >= 4, message="the events")
            spans = sorted(await client.query(), key=lambda s: s["ts"])
            assert [(s["ts"] - t, s["end"] - t) for s in spans] == [(0, 100), (10, 20)]

    run(test())


def test_an_end_without_a_begin_is_ignored(quiet_server):
    path = quiet_server.log_dir / "orphan.vson"

    async def test():
        async with Client(quiet_server.ws_url) as client:
            append(path, line({"name": "orphan", "ph": "E", "pid": 1, "tid": 1, "ts": now_us()}))
            append(path, complete("valid", now_us(), 100))
            await client.until(lambda: client.spans, message="the valid event")
            await asyncio.sleep(0.3)
            assert [s["name"] for s in client.spans] == ["valid"]

    run(test())


def test_broken_lines_are_skipped(quiet_server):
    path = quiet_server.log_dir / "broken.vson"

    async def test():
        async with Client(quiet_server.ws_url) as client:
            append(path, "[\n")                               # the start of the JSON array
            append(path, "this is not json\n")
            append(path, '{"name": "no_phase", "ts": 1},\n')
            append(path, '{"ph": "X", "ts": "not a number", "dur": 5},\n')
            append(path, "\n")
            append(path, complete("valid", now_us(), 100))
            await client.until(lambda: client.spans, message="the valid event")
            await asyncio.sleep(0.3)
            assert [s["name"] for s in client.spans] == ["valid"]

    run(test())


def test_triggers_with_a_duration_and_a_filter(quiet_server):
    path = quiet_server.log_dir / "triggers.vson"

    async def test():
        async with Client(quiet_server.ws_url) as client:
            await client.ws.send(json.dumps({"action": "watch_trigger", "triggerId": 1, "pattern": "job*", "edge": "falling",
                                             "duration": {"op": ">", "us": 1000}}))
            await client.request("set_filter", rules=[{"field": "name", "pattern": "job_hidden", "match": "normal", "type": "exclude"}])
            t = now_us()
            append(path, complete("job_short", t, 500))
            append(path, complete("job_long", t + 1000, 2000))
            append(path, complete("job_hidden", t + 4000, 5000))     # long enough, but filtered
            append(path, complete("other_long", t + 10_000, 5000))   # long enough, but another name
            append(path, complete("done", t + 20_000, 1))
            await client.until(lambda: any(s["name"] == "done" for s in client.spans), message="the last event")
            await asyncio.sleep(0.2)
            assert [tr["timeUs"] for tr in client.triggers] == [t + 3000]     # the end of 'job_long'
            assert "job_hidden" not in [s["name"] for s in client.spans]

    run(test())


def test_a_burst_is_read_quickly(quiet_server):
    path = quiet_server.log_dir / "burst.vson"
    count = 100_000
    t = now_us()
    # one write of 100000 events, ~8 MB, like a program that dumps its buffer
    append(path, "".join(complete(f"event_{i % 50}", t + i * 10, 5, tid=i % 8) for i in range(count)))

    async def test():
        async with Client(quiet_server.ws_url) as client:
            started = time.monotonic()

            async def all_read():
                return (await client.request("bounds"))[0]["lastUs"] == t + (count - 1) * 10

            while not await all_read():
                assert time.monotonic() - started < 30, "the burst was not read within 30 seconds"
                await asyncio.sleep(0.1)
            seconds = time.monotonic() - started
            print(f"\n{count} events read in {seconds:.2f} s")
            spans = await client.query()
            assert len(spans) == count

    run(test())


def test_two_clients_get_the_same_events(quiet_server):
    path = quiet_server.log_dir / "shared.vson"

    async def test():
        async with Client(quiet_server.ws_url) as first, Client(quiet_server.ws_url) as second:
            for i in range(20):
                append(path, complete(f"event_{i}", now_us(), 10))
            await first.until(lambda: len(first.spans) == 20, message="the events of the first client")
            await second.until(lambda: len(second.spans) == 20, message="the events of the second client")
            assert [s["id"] for s in first.spans] == [s["id"] for s in second.spans]

    run(test())


def test_the_server_survives_a_client_that_disappears(quiet_server):
    async def test():
        # a client that asks for a lot and leaves before the reply is sent
        ws = await websockets.connect(quiet_server.ws_url, max_size=None)
        await ws.send(json.dumps({"action": "query", "requestId": 1, "startUs": None, "endUs": None}))
        await ws.send(json.dumps({"action": "watch_trigger", "triggerId": 1, "pattern": "*", "edge": "rising"}))
        await ws.close()

        append(quiet_server.log_dir / "after.vson", complete("still_working", now_us(), 10))
        async with Client(quiet_server.ws_url) as client:
            await client.until(lambda: client.spans or None, message="an event")

    run(test())
    wait_for(lambda: quiet_server.process.poll() is None, message="the server to keep running")
