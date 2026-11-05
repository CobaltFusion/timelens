"""
Integration tests of the graph page: a real server, the live pipeline of 'load.py' and a headless browser. Every test
also fails when the page reports a JavaScript error, see 'page_factory'.
"""

from __future__ import annotations

import collections
import time

import pytest

from .load import IO, LOGGER, THREADS, WORKERS, line, now_us

pytestmark = pytest.mark.integration


@pytest.fixture
def page(live_server, page_factory):
    page = page_factory(live_server)
    page.wait_for(lambda: len(page.state()["events"]) > 100, message="events in the graph")
    return page


def set_graph(page, settings, index=0):
    page.evaluate("([index, settings]) => [...window.timelens.widgets][index].component.applySettings(settings)", [index, settings])


def duplicates(events):
    counts = collections.Counter((e["name"], e["tid"], e["ts"]) for e in events)
    return [key for key, count in counts.items() if count > 1]


def test_every_thread_gets_a_row(page):
    set_graph(page, {"graphWidthMs": 2000})
    # the logger only logs at a flush, every 3 seconds
    page.wait_for(lambda: set(THREADS) - {LOGGER} <= set(page.state()["rows"]), message="a row per thread")
    assert page.state()["rowLabelWidthPx"] == 160


def test_stop_shows_the_events_of_the_server_once(page):
    page.stop()
    # the stopped graph is filled from the server, every span once
    state = page.wait_for(lambda: (s := page.state())["events"] and s, message="the stopped range")
    assert duplicates(state["events"]) == []
    assert len({e["id"] for e in state["events"]}) == len(state["events"])

    # it stays where it is while new events arrive
    before = state["startUs"]
    time.sleep(0.5)
    page.frame()
    assert page.state()["startUs"] == before

    page.run()
    page.wait_for(lambda: page.state()["startUs"] > before, message="the graph to follow live data")


def test_live_data_has_no_duplicates(page):
    time.sleep(1)
    assert duplicates(page.state()["events"]) == []


def test_auto_trigger_follows_the_latest_trigger(page):
    set_graph(page, {"triggerWord": "grab_frame", "preTriggerMs": -5, "graphWidthMs": 20})
    page.wait_for(lambda: page.state()["status"] == "Auto", message="the auto status")
    first = page.wait_for(lambda: (s := page.state())["startUs"] > 0 and s["startUs"], message="a trigger")
    page.wait_for(lambda: page.state()["startUs"] > first, message="a later trigger")


def test_a_trigger_that_never_matches_waits(page):
    page.click("SINGLE")
    set_graph(page, {"triggerWord": "no_such_event"})
    page.click("SINGLE")
    page.wait_for(lambda: page.state()["status"] == "Wait", message="the wait status")
    time.sleep(0.5)
    page.frame()
    state = page.state()
    assert state["status"] == "Wait"
    assert state["rows"] == []      # nothing is drawn while waiting for a trigger


def test_single_records_after_its_trigger_then_stops(page):
    set_graph(page, {"triggerWord": "flush_log", "preTriggerMs": -50, "graphWidthMs": 100})
    page.evaluate("() => { [...window.timelens.widgets][0].component.triggerSource.singleRecordUs = 300_000; }")
    page.click("SINGLE")
    assert page.state()["status"] == "Wait"
    # a flush is logged every 3 seconds
    page.wait_for(lambda: page.state()["status"] == "Triggered", timeout=8, message="the trigger")
    page.wait_for(lambda: not page.state()["running"], timeout=5, message="the single capture to stop")

    state = page.wait_for(lambda: (s := page.state())["events"] and s, message="the captured events")
    assert any(e["name"] == "flush_log" for e in state["events"])
    assert duplicates(state["events"]) == []

    # RUN after a single capture continues in auto mode
    page.run()
    page.wait_for(lambda: page.state()["running"] and page.state()["status"] == "Auto", message="auto mode")


def test_switching_modes_quickly_ends_in_a_working_state(page):
    set_graph(page, {"triggerWord": "grab_frame", "graphWidthMs": 50})
    # STOP/RUN toggles, so this stops and runs in between, also while a single capture waits or a stopped range is fetched
    for _ in range(10):
        for button in ("SINGLE", "STOP", "AUTO", "SINGLE", "STOP", "AUTO", "SINGLE"):
            page.click(button)

    # a single capture after all that still triggers
    page.run()
    page.wait_for(lambda: page.state()["status"] in ("Wait", "Triggered"), message="the single capture")
    page.click("AUTO")
    page.run()
    page.wait_for(lambda: page.state()["status"] == "Auto", message="auto mode")
    first = page.wait_for(lambda: (s := page.state())["startUs"] > 0 and s["startUs"], message="a trigger")
    page.wait_for(lambda: page.state()["startUs"] > first, message="the graph to follow the triggers")


def test_zoom_in_and_out_to_the_limits(page):
    page.select_graph()
    page.press("w", 80)
    state = page.state()
    assert state["manual"] and not state["running"]
    assert state["widthUs"] == pytest.approx(10)            # the narrowest view, 10 us

    page.press("s", 120)
    assert page.state()["widthUs"] == pytest.approx(600e6)  # the widest view, 10 minutes
    page.frame()

    page.press("q")
    state = page.state()
    assert state["running"] and not state["manual"]


def test_pan_far_away_from_the_data(page):
    page.select_graph()
    page.press("a", 300)        # 30 views back, before the first event
    page.frame()
    page.press("d", 600)        # into the future, after the last event
    page.frame()
    assert page.state()["manual"]
    page.press("q")
    page.wait_for(lambda: page.state()["running"], message="live data")
    page.wait_for(lambda: page.state()["events"], message="events")


def test_zoomed_view_fetches_the_events_it_shows(page):
    set_graph(page, {"graphWidthMs": 200})
    page.select_graph()
    page.press("w", 10)
    state = page.wait_for(lambda: (s := page.state())["events"] and s, message="the events of the zoomed view")
    begin, end = state["startUs"], state["startUs"] + state["widthUs"]
    assert any(e["ts"] <= end and (e["end"] or e["ts"]) >= begin for e in state["events"])
    assert duplicates(state["events"]) == []


def test_pre_trigger_changes_a_frozen_view(page):
    page.select_graph()
    page.press("w", 2)
    before = page.state()
    right = before["startUs"] + before["widthUs"]
    page.evaluate("() => [...window.timelens.widgets][0].component.setPreTrigger(-200)")
    page.frame()
    after = page.state()
    assert after["manual"]
    assert after["startUs"] + after["widthUs"] == pytest.approx(right)    # the right edge stays
    assert after["startUs"] < before["startUs"]


def test_trigger_settings_change_while_stopped(page):
    page.stop()
    page.wait_for(lambda: page.state()["events"], message="the stopped range")
    for edge in ("falling", "rising"):
        for duration in (None, {"op": ">", "us": 30_000}, {"op": "<", "us": 1}):
            set_graph(page, {"triggerWord": "process_image", "triggerEdge": edge, "triggerDuration": duration})
            page.frame()
    assert not page.state()["running"]


def test_filters_apply_to_a_stopped_graph(page):
    page.stop()
    page.wait_for(lambda: any(e["name"] == "poll_plc" for e in page.state()["events"]), message="poll events")

    page.evaluate("() => window.timelens.applyFilters([{field: 'name', pattern: 'poll_plc', match: 'normal', type: 'exclude'}])")
    page.wait_for(lambda: (events := page.state()["events"]) and not any(e["name"] == "poll_plc" for e in events), message="the filtered events")

    page.evaluate("() => window.timelens.applyFilters([])")
    page.wait_for(lambda: any(e["name"] == "poll_plc" for e in page.state()["events"]), message="the unfiltered events")


def test_clear_while_running_and_while_stopped(page):
    page.page.get_by_text("Clear", exact=True).click()
    page.frame()
    page.wait_for(lambda: page.state()["events"], message="new events after clear")

    page.stop()
    page.wait_for(lambda: page.state()["events"], message="the stopped range")
    page.page.get_by_text("Clear", exact=True).click()
    page.frame()
    assert page.state()["events"] == []
    page.run()
    page.wait_for(lambda: page.state()["events"], message="new events after run")


def test_a_narrow_graph_has_no_row_labels(page):
    page.evaluate("() => { const w = [...window.timelens.widgets][0]; w.setSize({ width: '300px', height: '250px' }); w.resize(); }")
    page.wait_for(lambda: page.state()["rowLabelWidthPx"] == 0 and page.state()["rows"], message="a narrow graph")


def test_add_and_close_graphs(page):
    for _ in range(3):
        page.page.get_by_text("Add Graph", exact=True).click()
    assert page.graph_count() == 4
    set_graph(page, {"triggerWord": "send_result", "triggerEdge": "falling"}, index=3)
    page.wait_for(lambda: page.state(3)["rows"], message="the new graph to draw")
    for _ in range(3):
        page.page.locator(".resizable-container-close").first.click()
    assert page.graph_count() == 1
    page.wait_for(lambda: page.state()["rows"], message="the last graph to draw")


def test_the_threads_of_a_frame_overlap_as_logged(page):
    # 'process_image' of a worker contains 'detect_edges' and 'classify', they get lanes under it in the same row
    set_graph(page, {"triggerWord": "process_image", "triggerEdge": "falling", "preTriggerMs": -40, "graphWidthMs": 5})
    page.wait_for(lambda: any(row in WORKERS for row in page.state()["rows"]), message="a worker row")
    lanes = page.evaluate("""() => {
        const bars = [...window.timelens.widgets][0].component.lastBars;
        return [...bars.lines.entries()].map(([tid, line]) => [tid, line.lanes.length]);
    }""")
    assert any(tid in WORKERS and count >= 2 for tid, count in lanes)
    assert all(count == 1 for tid, count in lanes if tid == IO)


# ---------------------------------------------------------------- what the graph draws of a view
# The graph does not look at all events of the buffer for a view, see 'Graph.#scanStart'. These are the events that
# can be far from the view in the buffer and still be visible.

def write_live(path, lines):
    with path.open("a", encoding="utf8", newline="\n") as f:
        f.write("".join(lines))


def busy_seconds(path, seconds, tid=1):
    """Writes small events on 'tid' for 'seconds', as they happen, so the buffer has many events after what came before."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        t = now_us()
        write_live(path, [line({"name": "tick", "ph": "X", "pid": 1, "tid": tid, "ts": t + i * 100, "dur": 50}) for i in range(10)])
        time.sleep(0.001)


def show_marker(page):
    """Triggers on the 'marker' event: a view of 100 ms that ends 50 ms after it."""
    set_graph(page, {"triggerWord": "marker", "preTriggerMs": -50, "graphWidthMs": 50})


def test_a_long_event_that_began_before_the_view_is_drawn(quiet_server, page_factory):
    page = page_factory(quiet_server)
    path = quiet_server.log_dir / "long.vson"
    begin = now_us()
    write_live(path, [line({"name": "long_job", "ph": "B", "pid": 1, "tid": 2, "ts": begin})])
    busy_seconds(path, 2)
    t = now_us()
    write_live(path, [line({"name": "long_job", "ph": "E", "pid": 1, "tid": 2, "ts": t + 30_000}),
                      line({"name": "marker", "ph": "X", "pid": 1, "tid": 3, "ts": t, "dur": 10})])
    show_marker(page)
    page.wait_for(lambda: "long_job" in page.state()["drawn"], message="the long event in the view")


def test_an_open_event_that_began_long_before_the_view_is_drawn(quiet_server, page_factory):
    page = page_factory(quiet_server)
    path = quiet_server.log_dir / "open.vson"
    write_live(path, [line({"name": "still_open", "ph": "B", "pid": 1, "tid": 2, "ts": now_us()})])
    busy_seconds(path, 2)
    write_live(path, [line({"name": "marker", "ph": "X", "pid": 1, "tid": 3, "ts": now_us(), "dur": 10})])
    show_marker(page)
    page.wait_for(lambda: "still_open" in page.state()["drawn"], message="the open event in the view")

    # also in a stopped graph, which shows the events of the server
    page.stop()
    page.wait_for(lambda: "still_open" in page.state()["drawn"], message="the open event in the stopped view")


def test_a_log_file_with_a_clock_that_is_behind_is_drawn(quiet_server, page_factory):
    page = page_factory(quiet_server)
    # this program's clock is 20 seconds behind: far before everything else in the buffer, but within the minute the
    # browser keeps (it drops what is more than a minute older than the newest event)
    behind_us = 20 * 1_000_000
    slow = quiet_server.log_dir / "slow_clock.vson"
    write_live(slow, [line({"name": "marker", "ph": "X", "pid": 2, "tid": 5, "ts": now_us() - behind_us, "dur": 10}),
                      line({"name": "behind", "ph": "X", "pid": 2, "tid": 5, "ts": now_us() - behind_us + 5_000, "dur": 1_000})])
    busy_seconds(quiet_server.log_dir / "fast_clock.vson", 1)
    show_marker(page)
    page.wait_for(lambda: "behind" in page.state()["drawn"], message="the event of the slow clock")
