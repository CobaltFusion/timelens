#!/usr/bin/env python3

import asyncio
import contextlib
from contextlib import asynccontextmanager
import json
import os
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from pathlib import Path

logger = logging.getLogger(__name__)


async def tail_file(path, callback):
    logging.warning(f"file: {path}")

    with open(path, "r", encoding="utf-8") as f:
        f.seek(0)  # start at end

        while True:
            line = f.readline()
            if not line:
                await asyncio.sleep(0.1)
                continue

            # logging.warning(f"message: {line.strip()}")
            await callback(line, path)


async def watch_directory(path, callback):
    known = set()

    while True:
        current = {
            f for f in os.listdir(path)
            if f.endswith(".vson")
        }

        new_files = current - known
        for fname in new_files:
            full_path = os.path.join(path, fname)
            asyncio.create_task(tail_file(full_path, callback))

        known = current
        await asyncio.sleep(1)


async def handle_line(line, path):

    if line.startswith('['):
        line = line[1:]

    if line.endswith(',\n'):
        line = line[:-2]
    try:
        evt = json.loads(line)
    except json.JSONDecodeError:
        logging.error("line error: %s", line)
        return

    evt["source"] = os.path.basename(path)

    await broadcast(evt)


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
        path = "c:/temp/logs/telemetry"
    logging.warning("Monitoring path: %s", path)

    task = asyncio.create_task(

        watch_directory(path, handle_line)
    )
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def handle_reset():
    logging.warning("RESET received")


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
                await handle_reset()

    except WebSocketDisconnect:
        clients.remove(websocket)


@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def devtools():
    # this silences harmless message that would otherwise appear when 'F12' it pressed in the browser
    return JSONResponse({})


app.mount("/", StaticFiles(directory="webclient", html=True), name="webclient")
