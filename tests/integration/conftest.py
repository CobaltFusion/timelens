"""
Fixtures of the integration tests: a real TimeLens server on a free port, with its own log folder and home folder (so
the profiles of the user are not used), the simulated pipeline of 'load.py' logging to it live, and a headless browser.

The browser tests need Playwright and a browser: Edge or Chrome that is installed, or Playwright's own Chromium
('python -m playwright install chromium'). Without one they are skipped.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from .load import LiveLog

SERVER_DIRECTORY = Path(__file__).resolve().parents[2] / "src" / "timelens"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(condition, timeout=10.0, interval=0.05, message="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = condition()
        if result:
            return result
        time.sleep(interval)
    raise AssertionError(f"timed out after {timeout} s waiting for {message}")


class RunningServer:
    def __init__(self, url, log_dir, home, process):
        self.url = url
        self.ws_url = url.replace("http://", "ws://") + "/ws"
        self.log_dir = log_dir
        self.home = home
        self.process = process


def start_server(log_dir: Path, home: Path) -> RunningServer:
    port = free_port()
    env = {
        **os.environ,
        "TIMELENS_LOG_DIR": str(log_dir),
        "TIMELENS_SYSTEM_INTERVAL": "0",
        "TIMELENS_PEER_DISCOVERY": "0",
        "HOME": str(home),
        "USERPROFILE": str(home),
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=SERVER_DIRECTORY, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"

    def up():
        if process.poll() is not None:
            raise AssertionError(f"the server ended with exit code {process.returncode}")
        try:
            with urllib.request.urlopen(url + "/graph.html", timeout=1) as reply:
                return reply.status == 200
        except OSError:
            return False

    wait_for(up, timeout=30, message="the server to start")
    return RunningServer(url, log_dir, home, process)


def stop_server(server: RunningServer):
    server.process.terminate()
    try:
        server.process.wait(10)
    except subprocess.TimeoutExpired:
        server.process.kill()


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """A server and the live pipeline, shared by the tests of a module."""
    log_dir = tmp_path_factory.mktemp("logs")
    home = tmp_path_factory.mktemp("home")
    log = LiveLog(log_dir).start()
    server = start_server(log_dir, home)
    server.log = log
    yield server
    stop_server(server)
    log.stop()


@pytest.fixture
def quiet_server(tmp_path):
    """A server with an empty log folder, for tests that write their own events."""
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    server = start_server(log_dir, home)
    yield server
    stop_server(server)


# ---------------------------------------------------------------- the browser

# Per module: while Playwright's sync API runs, the main thread has an event loop, and 'asyncio.run()' of the other
# tests would fail.
@pytest.fixture(scope="module")
def browser():
    playwright_api = pytest.importorskip("playwright.sync_api")
    playwright = playwright_api.sync_playwright().start()
    launched = None
    for options in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
        try:
            launched = playwright.chromium.launch(headless=True, **options)
            break
        except Exception:      # this browser is not installed, try the next one
            continue
    if launched is None:
        playwright.stop()
        pytest.skip("no browser for Playwright, install one with 'python -m playwright install chromium'")
    yield launched
    launched.close()
    playwright.stop()


class TimeLensPage:
    """The graph page, with helpers to look at the state of its graphs through 'window.timelens' (see graph_main.js)."""

    def __init__(self, page, server):
        self.page = page
        self.server = server
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(f"page error: {error}"))
        page.on("console", self._on_console)
        page.on("response", lambda response: self.failed_requests.append(f"{response.status} {response.url}") if response.status >= 400 else None)
        self.failed_requests = []

    def _on_console(self, message):
        # the browser logs a failed request as an error, those are checked by their url, see 'failed_requests'
        if message.type == "error" and not message.text.startswith("Failed to load resource"):
            self.errors.append(f"console.error: {message.text}")

    def open(self):
        self.page.goto(self.server.url + "/graph.html?test=1")
        self.page.wait_for_function("() => window.timelens && window.timelens.collector.isConnected() && window.timelens.widgets.size > 0")
        return self

    def evaluate(self, script, argument=None):
        return self.page.evaluate(script, argument)

    def state(self, index=0):
        """What a graph shows: running or not, a manual (panned/zoomed) view, the trigger status, rows and the data."""
        return self.evaluate("""index => {
            const graph = [...window.timelens.widgets][index].component;
            const data = graph.manualView ? graph.manualView.data : graph.triggerSource.getGraphData();
            const events = [];
            for (let i = 0; i < data.length; ++i) {
                const e = data.at(i);
                events.push({ id: e.id, name: e.name, ts: e.timestamp, end: e.end_time ?? null, type: e.type, tid: e.groupId });
            }
            return {
                running: graph.isRunning(),
                manual: graph.manualView !== null,
                status: graph.getTriggerStatus(),
                rows: graph.lastBars ? [...graph.lastBars.lines.keys()] : [],
                // the names of the events that were drawn in the last frame
                drawn: graph.lastBars ? [...graph.lastBars.lines.values()].flatMap(line => line.layoutEvents.map(e => e.name)) : [],
                rowLabelWidthPx: graph.rowLabelWidthPx,
                startUs: graph.startPointUs,
                widthUs: graph.graphWidthUs,
                events,
            };
        }""", index)

    def graph_count(self):
        return self.evaluate("() => window.timelens.widgets.size")

    def panel(self, index=0):
        return self.page.locator(".resizable-container").nth(index)

    def click(self, text, index=0):
        self.panel(index).get_by_text(text, exact=True).click()

    # STOP/RUN is one button that toggles
    def stop(self, index=0):
        if self.state(index)["running"]:
            self.click("STOP", index)
        wait_for(lambda: not self.state(index)["running"], message="the graph to stop")

    def run(self, index=0):
        if not self.state(index)["running"]:
            self.click("RUN", index)
        wait_for(lambda: self.state(index)["running"], message="the graph to run")

    def select_graph(self, index=0):
        self.evaluate("index => [...window.timelens.widgets][index].select()", index)

    def press(self, key, times=1):
        for _ in range(times):
            self.page.keyboard.press(key)

    def wait_for(self, condition, timeout=10.0, message="condition"):
        return wait_for(condition, timeout=timeout, message=message)

    def frame(self):
        """Waits for the next two animation frames, so everything that changed has been drawn."""
        self.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


@pytest.fixture
def page_factory(browser):
    """Opens the graph page of a server, a test fails when the page reports a JavaScript error."""
    opened = []

    def open_page(server, width=1300, height=700):
        context = browser.new_context(viewport={"width": width, "height": height})
        page = TimeLensPage(context.new_page(), server)
        opened.append((context, page))
        return page.open()

    yield open_page
    errors = [error for _, page in opened for error in page.errors]
    # a fresh server has no 'default' profile, the page then shows one graph: that 404 is expected
    errors += [f"request failed: {request}" for _, page in opened for request in page.failed_requests
               if not request.endswith("/api/profiles/default")]
    for context, _ in opened:
        context.close()
    assert errors == [], "the page reported errors:\n" + "\n".join(errors)
