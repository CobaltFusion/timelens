#!/usr/bin/env python3

import asyncio
import contextlib
import json
import logging
import socket


logger = logging.getLogger(__name__)

DISCOVERY_PORT = 37020
DISCOVERY_REQUEST = b"timelens-discovery-v1"


class PeerDiscovery:
    def __init__(self, http_port):
        self.http_port = http_port
        self.running = False
        self.task = None

    async def start(self):
        if self.running:
            return

        self.running = True
        self.task = asyncio.create_task(self._listen())

    async def stop(self):
        if not self.running:
            return

        self.running = False

        if self.task:
            self.task.cancel()

            with contextlib.suppress(asyncio.CancelledError):
                await self.task

            self.task = None

    async def _listen(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", DISCOVERY_PORT))
            sock.setblocking(False)

            logger.warning("Listening for peer discovery on UDP port %d", DISCOVERY_PORT)

            loop = asyncio.get_running_loop()

            while self.running:
                try:
                    data, address = await loop.sock_recvfrom(sock, 4096)

                    if data != DISCOVERY_REQUEST:
                        continue

                    response = json.dumps({"name": socket.gethostname(), "address": address[0], "port": self.http_port}).encode()

                    await loop.sock_sendto(
                        sock,
                        response,
                        (address[0], DISCOVERY_PORT),
                    )

                except asyncio.CancelledError:
                    raise

                except Exception:
                    logger.exception("Error handling discovery request")

        finally:
            sock.close()

    async def discover(self, timeout=0.5):
        """Discover other servers on the local network."""

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        try:
            sock.setsockopt(
                socket.SOL_SOCKET,
                socket.SO_BROADCAST,
                1,
            )
            sock.setsockopt(
                socket.SOL_SOCKET,
                socket.SO_REUSEADDR,
                1,
            )

            sock.bind(("", 0))
            sock.setblocking(False)

            loop = asyncio.get_running_loop()

            await loop.sock_sendto(sock, DISCOVERY_REQUEST, ("255.255.255.255", DISCOVERY_PORT))

            peers = []
            deadline = loop.time() + timeout

            while True:
                remaining = deadline - loop.time()

                if remaining <= 0:
                    break

                try:
                    data, address = await asyncio.wait_for(
                        loop.sock_recvfrom(sock, 4096),
                        remaining,
                    )
                except asyncio.TimeoutError:
                    break

                try:
                    peer = json.loads(data)
                    peer["address"] = address[0]
                    peers.append(peer)
                except json.JSONDecodeError:
                    continue

            # Remove duplicate responses.
            unique = {(peer["address"], peer["port"]): peer for peer in peers}

            return list(unique.values())

        finally:
            sock.close()
