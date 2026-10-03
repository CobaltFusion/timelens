#!/usr/bin/env python3

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from timelens.event_store import EventStore
from timelens.logwatcher import LogWatcher
from timelens.peer_discovery import PeerDiscovery

logger = logging.getLogger(__name__)

# Range replies are sent in chunks of this many events, up to a total of 'QUERY_LIMIT'.
QUERY_CHUNK_SIZE = 10_000
QUERY_LIMIT = 500_000


class Server:
    def __init__(self):
        self.clients = set()
        self.watcher = None
        self.peer_discovery = None
        self.store = EventStore()
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

        self.store.add(evt)
        await self.broadcast(evt)

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

    @asynccontextmanager
    async def lifespan(self, app):

        path = Path("/tmp/logs/telemetry")
        if not path.is_dir():
            logger.warning("Path missing: %s", path)
            path = Path("c:/temp/logs/telemetry")

        logger.warning("Monitoring path: %s", path)

        self.watcher = LogWatcher(path, self.handle_line)
        await self.watcher.start()

        self.peer_discovery = PeerDiscovery(http_port=8080)
        await self.peer_discovery.start()

        try:
            yield
        finally:
            await self.watcher.stop()

    # Sends the stored events with startUs <= ts <= endUs to 'websocket' only, in chunks.
    # The last chunk has 'done' set, it is also sent when there are no events.
    async def handle_query(self, websocket, msg):
        request_id = msg.get("requestId")
        start_us = msg.get("startUs")
        end_us = msg.get("endUs")
        start_us = float("-inf") if start_us is None else start_us
        end_us = float("inf") if end_us is None else end_us

        events, truncated = self.store.query(start_us, end_us, QUERY_LIMIT)

        offset = 0
        while True:
            chunk = events[offset:offset + QUERY_CHUNK_SIZE]
            offset += len(chunk)
            done = offset >= len(events)
            await websocket.send_text(json.dumps({
                "type": "range",
                "requestId": request_id,
                "events": chunk,
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

        except WebSocketDisconnect:
            self.clients.remove(websocket)

    async def devtools(self):
        # Silence a harmless message from Chrome DevTools.
        return JSONResponse({})

    async def servers(self):
        peers = await self.peer_discovery.discover()
        return JSONResponse({"servers": peers})


server = Server()
app = server.app
