#!/usr/bin/env python3

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from timelens.logwatcher import LogWatcher
from timelens.peer_discovery import PeerDiscovery
from timelens.profile_store import DEFAULT_PROFILE, ProfileStore
from timelens.span_store import SpanStore
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
        self.watches = {}   # websocket -> {triggerId: (matcher, edge)}
        self.count = 0

        self.app = FastAPI(lifespan=self.lifespan)

        @self.app.middleware("http")
        async def disable_cache(request: Request, call_next):
            response = await call_next(request)
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
        self.app.mount("/", StaticFiles(directory="webclient", html=True), name="webclient")

    async def handle_line(self, line, path):

        if line.startswith("["):
            line = line[1:]

        if line.endswith(",\n"):
            line = line[:-2]

        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            logger.error("line error: %s", line)
            return

        evt["source"] = os.path.basename(path)

        self.count = self.count + 1
        evt["count"] = self.count

        span, edges = self.store.add(evt)
        if span is None:
            return

        # an open span is sent when it begins, the same span (same id) again when it ends
        await self.broadcast({"type": "span", **span})
        await self.notify_triggers(span, edges)

    # Sends a 'trigger' message for each edge that matches a watch of a client.
    async def notify_triggers(self, span, edges):
        for websocket, watches in list(self.watches.items()):
            for trigger_id, (matcher, watched_edge) in list(watches.items()):
                for edge, time_us in edges:
                    if edge != watched_edge or not matcher(span["name"]):
                        continue
                    try:
                        await websocket.send_text(json.dumps({
                            "type": "trigger",
                            "triggerId": trigger_id,
                            "timeUs": time_us,
                        }))
                    except Exception:
                        logger.exception("Failed to send trigger to WebSocket")
                        self.watches.pop(websocket, None)

    async def broadcast(self, message):

        dead = []
        data = json.dumps(message)

        for ws in self.clients:
            try:
                await ws.send_text(data)
            except Exception:
                logger.exception("Failed to broadcast to WebSocket")
                dead.append(ws)

        for ws in dead:
            self.clients.remove(ws)
            self.watches.pop(ws, None)

    @asynccontextmanager
    async def lifespan(self, app):

        path = Path("/tmp/logs/telemetry")
        if not path.is_dir():
            logger.warning("Path missing: %s", path)
            path = Path("c:/temp/logs/telemetry")

        logger.warning("Monitoring path: %s", path)

        self.watcher = LogWatcher(path, self.handle_line, history_us=self.store.retention_us)
        await self.watcher.start()

        self.peer_discovery = PeerDiscovery(http_port=8080)
        await self.peer_discovery.start()

        try:
            yield
        finally:
            await self.watcher.stop()

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

        spans, truncated = self.store.query(start_us, end_us, QUERY_LIMIT)

        offset = 0
        while True:
            chunk = spans[offset:offset + QUERY_CHUNK_SIZE]
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
            "stats": self.store.stats(start_us, end_us),
        }))

    # The time of the first or last matching edge in [startUs, endUs], null if there is none.
    async def handle_find(self, websocket, msg):
        start_us, end_us = self.range_of(msg)
        matcher = make_wildcard_matcher(msg.get("pattern") or "")
        time_us = self.store.find(matcher, msg.get("edge"), start_us, end_us, msg.get("which", "last"))
        await websocket.send_text(json.dumps({
            "type": "found",
            "requestId": msg.get("requestId"),
            "timeUs": time_us,
        }))

    # From now on, a 'trigger' message is sent for every edge that matches 'pattern'.
    def handle_watch_trigger(self, websocket, msg):
        matcher = make_wildcard_matcher(msg.get("pattern") or "")
        self.watches.setdefault(websocket, {})[msg.get("triggerId")] = (matcher, msg.get("edge"))

    def handle_unwatch_trigger(self, websocket, msg):
        watches = self.watches.get(websocket)
        if watches is not None:
            watches.pop(msg.get("triggerId"), None)

    async def websocket_endpoint(self, websocket: WebSocket):

        await websocket.accept()
        self.clients.add(websocket)

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

        except WebSocketDisconnect:
            self.clients.discard(websocket)
            self.watches.pop(websocket, None)

    async def devtools(self):
        # Silence a harmless message from Chrome DevTools.
        return JSONResponse({})

    async def servers(self):
        peers = await self.peer_discovery.discover()
        return JSONResponse({"servers": peers})

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
