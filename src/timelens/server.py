#!/usr/bin/env python3

import asyncio
import contextlib
import json
import logging
import os
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from timelens.peer_discovery import PeerDiscovery

logger = logging.getLogger(__name__)


async def handle_line(line, path):

    if line.startswith("["):
        line = line[1:]

    if line.endswith(",\n"):
        line = line[:-2]
    try:
        evt = json.loads(line)
    except json.JSONDecodeError:
        logging.error("line error: %s", line)
        return

    evt["source"] = os.path.basename(path)

    await broadcast(evt)


class LogWatcher:
    def __init__(self, path, callback):
        self.path = path
        self.callback = callback

        self.watch_task = None
        self.tail_tasks = set()

        self._running = False

    async def start(self):
        if self._running:
            return

        logging.warning(f"Starting watcher on {self.path}")
        self._running = True
        self.watch_task = asyncio.create_task(self._watch_directory())

    async def stop(self):
        if not self._running:
            return

        logging.warning("Stopping watcher")
        self._running = False

        # Stop directory watcher
        if self.watch_task:
            self.watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.watch_task
            self.watch_task = None

        # Stop all tail tasks
        tasks = list(self.tail_tasks)
        for task in tasks:
            task.cancel()

        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

        self.tail_tasks.clear()

    async def restart(self):
        logging.warning("Restarting watcher")
        await self.stop()
        await self.start()

    async def _watch_directory(self):
        known = set()

        try:
            while True:
                try:
                    current = {f for f in os.listdir(self.path) if f.endswith(".vson")}
                except FileNotFoundError:
                    # logging.error(f"Directory not found: {self.path}")
                    await asyncio.sleep(1)
                    continue

                new_files = current - known

                for fname in new_files:
                    full_path = os.path.join(self.path, fname)
                    logging.warning(f"New file detected: {full_path}")

                    task = asyncio.create_task(self._tail_file(full_path))
                    self.tail_tasks.add(task)

                    # Remove from set when done
                    task.add_done_callback(self.tail_tasks.discard)

                known = current
                await asyncio.sleep(1)

        except asyncio.CancelledError:
            logging.warning("Directory watcher cancelled")
            raise

        finally:
            tasks = list(self.tail_tasks)
            # Ensure all tail tasks are cancelled
            for task in tasks:
                task.cancel()

            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task

            self.tail_tasks.clear()

    async def _tail_file(self, path):
        logging.warning(f"Start tailing: {path}")

        try:
            with open(path, encoding="utf-8") as f:
                while True:
                    line = f.readline()

                    if not line:
                        await asyncio.sleep(0.1)
                        continue

                    # logging.warning(f"{os.path.basename(path)}: {line.strip()}")

                    # Ordered processing (important!)
                    await self.callback(line, path)

        except asyncio.CancelledError:
            logging.warning(f"Stopped tailing: {path}")
            raise

        except Exception as e:
            logging.error(f"Error in tail_file({path}): {e}")


clients = set()


async def broadcast(message):

    dead = []
    data = json.dumps(message)

    for ws in clients:
        try:
            logging.warning(f"broadcast: {message}")
            await ws.send_text(data)
        except:
            dead.append(ws)

    for ws in dead:
        clients.remove(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):

    path = Path("/tmp/logs/telemetry")
    if not path.is_dir():
        logging.warning("Path missing: %s", path)
        path = "c:/temp/logs/telemetry"
    logging.warning("Monitoring path: %s", path)

    watcher = LogWatcher(path, handle_line)
    app.state.watcher = watcher
    await watcher.start()

    peer_discovery = PeerDiscovery(http_port=8080)
    app.state.peer_discovery = peer_discovery
    await peer_discovery.start()

    try:
        yield  # <-- REQUIRED
    finally:
        await watcher.stop()


async def handle_reset(app: FastAPI):
    logging.warning("RESET received")
    await app.state.watcher.restart()


app = FastAPI(lifespan=lifespan)

# the order of the handlers below matters, the app.mount need to be last, otherwise it will shadow the other handlers


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)

    try:
        while True:
            data = await websocket.receive_text()

            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            if msg.get("action") == "reset":
                await handle_reset(websocket.app)

    except WebSocketDisconnect:
        clients.remove(websocket)


@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def devtools():
    # this silences a harmless message that would otherwise appear when 'F12' it pressed in the browser
    return JSONResponse({})


def filter_discovered_peers(peers):
    """Keep one entry per instance_id from the globally preferred subnet."""

    if not peers:
        return []

    subnet_counts = Counter(peer["subnet"] for peer in peers)
    preferred_subnet = max(subnet_counts, key=subnet_counts.get)

    result = {}
    for peer in peers:
        if peer["subnet"] != preferred_subnet:
            continue

        instance_id = peer["instance_id"]

        if instance_id not in result:
            result[instance_id] = peer

    return list(result.values())


@app.get("/api/servers")
async def servers():
    peer_discovery: PeerDiscovery = app.state.peer_discovery
    peers = filter_discovered_peers(await peer_discovery.discover())
    return JSONResponse({"servers": peers})


app.mount("/", StaticFiles(directory="webclient", html=True), name="webclient")
