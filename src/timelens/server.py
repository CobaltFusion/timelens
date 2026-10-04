#!/usr/bin/env python3

import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from timelens import speedtest
from timelens.event_filter import EventFilter
from timelens.logwatcher import LogWatcher
from timelens.names import Names, is_metadata
from timelens.peer_discovery import PeerDiscovery
from timelens.profile_store import DEFAULT_PROFILE, ProfileStore
from timelens.span_store import RISING, SPAN_PHASES, SpanStore, make_duration_test
from timelens.vson import LOG_DIRECTORIES, default_log_directory, parse_line
from timelens.wildcard import make_wildcard_matcher

logger = logging.getLogger(__name__)

# Range replies are sent in chunks of this many spans, up to a total of 'QUERY_LIMIT'.
QUERY_CHUNK_SIZE = 10_000
QUERY_LIMIT = 500_000

# Larger profiles are refused, a profile only holds a few settings per graph.
PROFILE_MAX_BYTES = 64 * 1024


class Server:
    def __init__(self):
        self.clients = set()
        self.watcher = None
        self.peer_discovery = None
        self.store = SpanStore()
        self.profiles = ProfileStore()
        self.names = Names()    # names of processes and threads, from the metadata events
        self.watches = {}   # websocket -> {triggerId: (matcher, edge, duration test or None)}
        self.filters = {}   # websocket -> EventFilter, clients without a filter get every span
        self.count = 0

        self.app = FastAPI(lifespan=self.lifespan)

        # one middleware for all headers, every middleware copies the chunks of the streaming responses
        @self.app.middleware("http")
        async def add_headers(request: Request, call_next):
            # the browser asks what a page from another origin may do with the speed test before it uploads
            if request.method == "OPTIONS" and request.url.path.startswith(speedtest.PATH_PREFIX):
                response = Response(status_code=204)
            else:
                response = await call_next(request)
            response.headers.update(speedtest.cors_headers(request.url.path, request.method))

            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            return response

        # The order matters: mount must be last, otherwise it can shadow
        # the other handlers.
        self.app.websocket("/ws")(self.websocket_endpoint)
        self.app.get("/.well-known/appspecific/com.chrome.devtools.json")(self.devtools)
        self.app.get("/api/servers")(self.servers)
        self.app.get("/api/profiles")(self.list_profiles)
        self.app.get("/api/profiles/{name}")(self.get_profile)
        self.app.put("/api/profiles/{name}")(self.put_profile)
        self.app.delete("/api/profiles/{name}")(self.delete_profile)
        self.app.get("/api/speedtest/ping")(self.speedtest_ping)
        self.app.get("/api/speedtest/download")(self.speedtest_download)
        self.app.post("/api/speedtest/upload")(self.speedtest_upload)
        self.app.mount("/", StaticFiles(directory="webclient", html=True), name="webclient")

    async def handle_line(self, line, path):

        try:
            evt = parse_line(line)
        except ValueError:
            logger.error("line error: %s", line)
            return

        if evt is None:
            return  # an empty line or a bracket

        # the name of a process or thread is not an event, the clients get it to show it with the events
        if is_metadata(evt):
            change = self.names.add(evt)
            if change is not None:
                await self.broadcast_message(Names.message(change))
            return

        # only begin, end and complete events are used, counters, instants and the like are ignored
        if evt.get("ph") not in SPAN_PHASES:
            return

        evt["source"] = os.path.basename(path)

        self.count = self.count + 1
        evt["count"] = self.count

        span, edges = self.store.add(evt)
        if span is None:
            return

        # an open span is sent when it begins, the same span (same id) again when it ends
        await self.broadcast_span(span)
        await self.notify_triggers(span, edges)

    # The span as it is sent to 'websocket', with the color of its filter, None if the filter rejects it.
    def filtered(self, websocket, span):
        event_filter = self.filters.get(websocket)
        if event_filter is None:
            return span
        if not event_filter.accepts(span):
            return None
        color = event_filter.color_of(span)
        return span if color is None else {**span, "color": color}

    # Sends a 'trigger' message for each edge that matches a watch of a client.
    # Spans the filter of the client rejects do not trigger.
    # A watch with a duration only triggers when the span has closed with a matching duration, the
    # time is then the begin ('rising') or the end ('falling') of the span.
    async def notify_triggers(self, span, edges):
        for websocket, watches in list(self.watches.items()):
            if self.filtered(websocket, span) is None:
                continue
            for trigger_id, (matcher, watched_edge, duration_test) in list(watches.items()):
                if not matcher(span["name"]):
                    continue

                if duration_test is None:
                    times = [time_us for edge, time_us in edges if edge == watched_edge]
                elif duration_test(span):
                    times = [span["ts"] if watched_edge == RISING else span["end"]]
                else:
                    times = []

                for time_us in times:
                    try:
                        await websocket.send_text(json.dumps({
                            "type": "trigger",
                            "triggerId": trigger_id,
                            "timeUs": time_us,
                        }))
                    except Exception:
                        logger.exception("Failed to send trigger to WebSocket")
                        self.watches.pop(websocket, None)

    # Sends 'span' to every client, filtered per client. Clients without a filter share one message.
    async def broadcast_span(self, span):

        dead = []
        unfiltered_data = json.dumps({"type": "span", **span})

        for ws in self.clients:
            if ws in self.filters:
                sent_span = self.filtered(ws, span)
                if sent_span is None:
                    continue
                data = json.dumps({"type": "span", **sent_span})
            else:
                data = unfiltered_data
            try:
                await ws.send_text(data)
            except Exception:
                logger.exception("Failed to broadcast to WebSocket")
                dead.append(ws)

        for ws in dead:
            self.forget(ws)

    # Sends 'message' as it is to every client, for messages that are the same for all of them.
    async def broadcast_message(self, message):
        data = json.dumps(message)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                logger.exception("Failed to send to WebSocket")
                self.forget(ws)

    def forget(self, websocket):
        self.clients.discard(websocket)
        self.watches.pop(websocket, None)
        self.filters.pop(websocket, None)

    # the 'accept' predicate for the store, None when the client has no filter
    def accept_of(self, websocket):
        event_filter = self.filters.get(websocket)
        return event_filter.accepts if event_filter is not None else None

    @asynccontextmanager
    async def lifespan(self, app):

        if not LOG_DIRECTORIES[0].is_dir():
            logger.warning("Path missing: %s", LOG_DIRECTORIES[0])
        path = default_log_directory()

        logger.warning("Monitoring path: %s", path)

        self.watcher = LogWatcher(path, self.handle_line, history_us=self.store.retention_us)
        await self.watcher.start()

        self.peer_discovery = PeerDiscovery(http_port=8080)
        await self.peer_discovery.start()

        try:
            yield
        finally:
            await self.watcher.stop()

    # The test for the 'duration' of a trigger request, {op: '>' or '<', us: number}, None without a
    # valid duration.
    @staticmethod
    def duration_test_of(msg):
        duration = msg.get("duration")
        if not isinstance(duration, dict):
            return None
        op, limit_us = duration.get("op"), duration.get("us")
        if op not in (">", "<") or isinstance(limit_us, bool) or not isinstance(limit_us, (int, float))                 or not limit_us >= 0:
            return None
        return make_duration_test(op, limit_us)

    # 'startUs'/'endUs' of a request, a missing or null bound is unbounded
    @staticmethod
    def range_of(msg):
        start_us = msg.get("startUs")
        end_us = msg.get("endUs")
        start_us = float("-inf") if start_us is None else start_us
        end_us = float("inf") if end_us is None else end_us
        return start_us, end_us

    # Sends the spans that overlap [startUs, endUs] to 'websocket' only, in chunks.
    # The last chunk has 'done' set, it is also sent when there are no spans.
    async def handle_query(self, websocket, msg):
        request_id = msg.get("requestId")
        start_us, end_us = self.range_of(msg)

        spans, truncated = self.store.query(start_us, end_us, QUERY_LIMIT, accept=self.accept_of(websocket))

        offset = 0
        while True:
            chunk = [self.filtered(websocket, span) for span in spans[offset:offset + QUERY_CHUNK_SIZE]]
            offset += len(chunk)
            done = offset >= len(spans)
            await websocket.send_text(json.dumps({
                "type": "range",
                "requestId": request_id,
                "spans": chunk,
                "done": done,
                "truncated": truncated,
            }))
            if done:
                break

    async def handle_bounds(self, websocket, msg):
        bounds = self.store.bounds()
        await websocket.send_text(json.dumps({
            "type": "bounds",
            "requestId": msg.get("requestId"),
            "firstUs": bounds[0] if bounds else None,
            "lastUs": bounds[1] if bounds else None,
        }))

    # Duration statistics per name over the closed spans that begin in [startUs, endUs].
    async def handle_stats(self, websocket, msg):
        start_us, end_us = self.range_of(msg)
        await websocket.send_text(json.dumps({
            "type": "stats",
            "requestId": msg.get("requestId"),
            "stats": self.store.stats(start_us, end_us, accept=self.accept_of(websocket)),
        }))

    # The time of the first or last matching edge in [startUs, endUs], null if there is none.
    async def handle_find(self, websocket, msg):
        start_us, end_us = self.range_of(msg)
        matcher = make_wildcard_matcher(msg.get("pattern") or "")
        time_us = self.store.find(matcher, msg.get("edge"), start_us, end_us, msg.get("which", "last"),
                                  accept=self.accept_of(websocket), duration=self.duration_test_of(msg))
        await websocket.send_text(json.dumps({
            "type": "found",
            "requestId": msg.get("requestId"),
            "timeUs": time_us,
        }))

    # Replaces the filter of 'websocket', an empty list of rules removes it. On an error the
    # previous filter stays and the reply has 'error' set, e.g. "rule 3: invalid regex: ...".
    async def handle_set_filter(self, websocket, msg):
        error = None
        try:
            event_filter = EventFilter(msg.get("rules") or [])
        except ValueError as exc:
            error = str(exc)
        else:
            if event_filter.is_empty():
                self.filters.pop(websocket, None)
            else:
                self.filters[websocket] = event_filter

        await websocket.send_text(json.dumps({
            "type": "filter",
            "requestId": msg.get("requestId"),
            "error": error,
        }))

    # From now on, a 'trigger' message is sent for every edge that matches 'pattern'.
    def handle_watch_trigger(self, websocket, msg):
        matcher = make_wildcard_matcher(msg.get("pattern") or "")
        self.watches.setdefault(websocket, {})[msg.get("triggerId")] = (
            matcher, msg.get("edge"), self.duration_test_of(msg))

    def handle_unwatch_trigger(self, websocket, msg):
        watches = self.watches.get(websocket)
        if watches is not None:
            watches.pop(msg.get("triggerId"), None)

    async def websocket_endpoint(self, websocket: WebSocket):

        await websocket.accept()
        self.clients.add(websocket)

        # the names of the processes and threads that are known, later ones are broadcast
        await websocket.send_text(json.dumps(self.names.snapshot()))

        try:
            while True:
                data = await websocket.receive_text()

                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    continue

                action = msg.get("action")

                if action == "query":
                    await self.handle_query(websocket, msg)

                if action == "bounds":
                    await self.handle_bounds(websocket, msg)

                if action == "stats":
                    await self.handle_stats(websocket, msg)

                if action == "find":
                    await self.handle_find(websocket, msg)

                if action == "watch_trigger":
                    self.handle_watch_trigger(websocket, msg)

                if action == "unwatch_trigger":
                    self.handle_unwatch_trigger(websocket, msg)

                if action == "set_filter":
                    await self.handle_set_filter(websocket, msg)

        except WebSocketDisconnect:
            self.forget(websocket)

    async def devtools(self):
        # Silence a harmless message from Chrome DevTools.
        return JSONResponse({})

    async def servers(self):
        peers = await self.peer_discovery.discover()
        return JSONResponse({"servers": peers})

    # The speed test: the page of any machine measures the latency and the bandwidth to this server.

    async def speedtest_ping(self):
        return Response(status_code=204)

    # exactly 'bytes' bytes of random data
    async def speedtest_download(self, size: str | None = Query(None, alias="bytes")):
        try:
            total = speedtest.parse_bytes(size)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        return StreamingResponse(speedtest.download_chunks(total), media_type="application/octet-stream",
                                 headers={"Content-Length": str(total)})

    # reads the whole body and tells how many bytes it had
    async def speedtest_upload(self, request: Request):
        try:
            count = await speedtest.count_upload(request.stream())
        except speedtest.TooLarge as exc:
            return JSONResponse({"error": str(exc)}, status_code=413)
        return JSONResponse({"bytes": count})

    async def list_profiles(self):
        return JSONResponse({"profiles": self.profiles.list(), "default": DEFAULT_PROFILE})

    async def get_profile(self, name: str):
        if not self.profiles.is_valid_name(name):
            return JSONResponse({"error": "invalid profile name"}, status_code=400)
        profile = self.profiles.load(name)
        if profile is None:
            return JSONResponse({"error": "profile not found"}, status_code=404)
        return JSONResponse(profile)

    async def put_profile(self, name: str, request: Request):
        if not self.profiles.is_valid_name(name):
            return JSONResponse({"error": "invalid profile name"}, status_code=400)

        body = await request.body()
        if len(body) > PROFILE_MAX_BYTES:
            return JSONResponse({"error": "profile is too large"}, status_code=413)
        try:
            profile = json.loads(body)
        except json.JSONDecodeError:
            profile = None
        if not isinstance(profile, dict):
            return JSONResponse({"error": "a profile must be a JSON object"}, status_code=400)

        self.profiles.save(name, profile)
        return Response(status_code=204)

    async def delete_profile(self, name: str):
        if not self.profiles.is_valid_name(name):
            return JSONResponse({"error": "invalid profile name"}, status_code=400)
        if not self.profiles.delete(name):
            return JSONResponse({"error": "profile not found"}, status_code=404)
        return Response(status_code=204)


server = Server()
app = server.app
