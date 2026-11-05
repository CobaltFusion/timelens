#!/usr/bin/env python3
"""
Measures the CPU time of TimeLens under load, to compare before and after a change. Not a test, run it by hand:

    python -m tests.integration.benchmark [--fps 300] [--graphs 2] [--seconds 20] [--warmup 30]

It starts a server on a temporary folder, the pipeline of 'load.py' at '--fps' frames per second (about 10 spans per
frame) and a headless browser with '--graphs' graphs. After '--warmup' seconds (the browser keeps a minute of events,
so a longer warmup fills more of it) it measures for '--seconds':

  render       the time of 'Graph.render()' per frame, average and 95th percentile, summed over the graphs
  main thread  the busy time of the main thread of the page, from the browser (scripts, layout and painting)
  server       the cpu time of the server process

and prints the number of events in the browser's buffer.
"""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

import psutil
from playwright.sync_api import sync_playwright

from .conftest import TimeLensPage, start_server, stop_server, wait_for
from .load import LiveLog

INSTRUMENT = """() => {
    window.renderTimes = [];
    for (const widget of window.timelens.widgets) {
        const graph = widget.component;
        const render = graph.render.bind(graph);
        graph.render = () => {
            const start = performance.now();
            render();
            window.renderTimes.push(performance.now() - start);
        };
    }
}"""


def launch(playwright):
    for options in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
        try:
            return playwright.chromium.launch(headless=True, **options)
        except Exception:
            continue
    raise SystemExit("no browser for Playwright, install one with 'python -m playwright install chromium'")


def print_profile(profile, seconds, top=15):
    """The functions with the most self time, from a CPU profile of the browser."""
    nodes = {node["id"]: node for node in profile["nodes"]}
    interval_ms = {}
    deltas = profile.get("timeDeltas", [])
    for sample, delta in zip(profile.get("samples", []), deltas, strict=True):
        frame = nodes[sample]["callFrame"]
        key = f"{frame['functionName'] or '(anonymous)'}  {Path(frame['url']).name}:{frame['lineNumber'] + 1}"
        interval_ms[key] = interval_ms.get(key, 0) + delta / 1000
    print("self time of the page, per second:")
    for key, ms in sorted(interval_ms.items(), key=lambda item: -item[1])[:top]:
        print(f"  {ms / seconds:7.1f} ms  {key}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fps", type=float, default=300, help="frames of the pipeline per second, about 10 spans each")
    parser.add_argument("--graphs", type=int, default=2)
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--warmup", type=float, default=30)
    parser.add_argument("--profile", action="store_true", help="also print the functions of the page that use the most time")
    parser.add_argument("--trigger", default="grab_frame", help="the trigger word of the graphs, '' for free running")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as temp:
        log_dir, home = Path(temp, "logs"), Path(temp, "home")
        log_dir.mkdir()
        home.mkdir()
        log = LiveLog(log_dir, frame_us=1e6 / args.fps, flush_every_frames=int(3 * args.fps)).start()
        server = start_server(log_dir, home)
        try:
            with sync_playwright() as playwright:
                browser = launch(playwright)
                page = TimeLensPage(browser.new_page(viewport={"width": 1300, "height": 900}), server).open()
                for _ in range(args.graphs - 1):
                    page.page.get_by_text("Add Graph", exact=True).click()
                for index in range(args.graphs):
                    settings = {"triggerWord": args.trigger, "preTriggerMs": -50, "graphWidthMs": 100}
                    page.evaluate("([index, settings]) => [...window.timelens.widgets][index].component.applySettings(settings)", [index, settings])

                time.sleep(args.warmup)
                cdp = page.page.context.new_cdp_session(page.page)
                cdp.send("Performance.enable")
                # on Windows the python.exe of a venv starts the real interpreter as a child process
                server_process = psutil.Process(server.process.pid)
                processes = [server_process, *server_process.children(recursive=True)]

                def server_cpu():
                    return sum(sum(p.cpu_times()[:2]) for p in processes)

                def busy():
                    metrics = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
                    return metrics["TaskDuration"]

                page.evaluate(INSTRUMENT)
                busy_before, cpu_before = busy(), server_cpu()
                if args.profile:
                    cdp.send("Profiler.enable")
                    cdp.send("Profiler.start")
                time.sleep(args.seconds)
                busy_after, cpu_after = busy(), server_cpu()
                if args.profile:
                    print_profile(cdp.send("Profiler.stop")["profile"], args.seconds)
                times = sorted(page.evaluate("() => window.renderTimes"))
                buffered = page.evaluate("() => window.timelens.collector.data().length")
                browser.close()
        finally:
            stop_server(server)
            log.stop()

    frames = len(times) / args.graphs
    per_frame = sum(times) / max(frames, 1)
    p95 = times[int(len(times) * 0.95)] if times else 0
    print(f"load         {args.fps:g} frames/s, {args.graphs} graphs, {buffered} events in the browser's buffer")
    print(f"render       {per_frame:.2f} ms per frame (all graphs), p95 of one graph {p95:.2f} ms, {frames / args.seconds:.0f} frames/s")
    print(f"main thread  {100 * (busy_after - busy_before) / args.seconds:.0f}% busy")
    print(f"server       {100 * (cpu_after - cpu_before) / args.seconds:.0f}% of a core")
    wait_for(lambda: True)


if __name__ == "__main__":
    main()
