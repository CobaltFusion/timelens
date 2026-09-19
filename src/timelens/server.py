#!/usr/bin/env python3

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from timelens.logwatcher import LogWatcher
from timelens.peer_discovery import PeerDiscovery

logger = logging.getLogger(__name__)


class Server:
    def __init__(self):
        self.clients = set()
        self.watcher = None
        self.peer_discovery = None
        self.startTimeUs = 0

        self.app = FastAPI(lifespan=self.lifespan)

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

        ts = evt["ts"]
        if ts < self.startTimeUs:
            return

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

    async def handle_reset(self):
        logger.warning("handle_reset restart!")
        self.startTimeUs = 0
        await self.watcher.restart()

    async def handle_request(self, timeUs):
        logger.warning(f"handle_request, timeUs: {timeUs}")
        self.startTimeUs = timeUs
        await self.watcher.restart()

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

                if msg.get("action") == "reset":
                    await self.handle_reset()

                if msg.get("action") == "request":
                    timeUs = msg.get("timeUs")
                    await self.handle_request(timeUs)

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
