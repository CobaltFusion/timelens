#!/usr/bin/env python3

import asyncio
import contextlib
import json
import logging
import socket
import uuid
from ipaddress import IPv4Network

import psutil

logger = logging.getLogger(__name__)

DISCOVERY_PORT = 37020
DISCOVERY_REQUEST = b"timelens-discovery-v1"


def get_ipv4_interfaces():
    """Return (interface, address, netmask, broadcast) for IPv4 interfaces."""

    interfaces = []

    for ifname, addresses in psutil.net_if_addrs().items():
        for address in addresses:
            if address.family != socket.AF_INET:
                continue

            if not address.netmask:
                continue

            network = IPv4Network(f"{address.address}/{address.netmask}", strict=False)

            if network.is_loopback:
                continue

            interfaces.append((ifname, address.address, address.netmask, str(network.broadcast_address)))

    return interfaces


class PeerDiscovery:
    def __init__(self, http_port):
        self.http_port = http_port
        self.instance_id = uuid.uuid4().hex
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
            sock.settimeout(0.5)

            logger.info("Listening for peer discovery on UDP port %d", DISCOVERY_PORT)

            while self.running:
                try:
                    data, address = await asyncio.to_thread(sock.recvfrom, 4096)

                    if data != DISCOVERY_REQUEST:
                        logger.info("Ignoring unknown discovery packet: %r", data)
                        continue

                    response = json.dumps({"name": socket.gethostname(), "port": self.http_port, "instance_id": self.instance_id}).encode()

                    # Reply to the sender's ephemeral port.
                    sock.sendto(response, address)

                    logger.info("Discovery request from %s, response: %s", address, response)

                except socket.timeout:
                    continue

                except asyncio.CancelledError:
                    raise

                except OSError:
                    if self.running:
                        logger.exception("Error receiving discovery request")

                except Exception:
                    logger.exception("Error handling discovery request")

        finally:
            sock.close()

    async def discover(self, timeout=0.5):
        """Discover other servers on all local IPv4 networks."""

        interfaces = get_ipv4_interfaces()

        for ifname, address, netmask, broadcast in interfaces:
            logger.info("Discovery interface %s: %s/%s -> %s", ifname, address, netmask, broadcast)

        peers = []
        loop = asyncio.get_running_loop()
        sockets = []

        try:
            # Send a broadcast on every IPv4 interface.
            for ifname, address, netmask, broadcast in interfaces:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

                    # An interface may disappear or become unavailable
                    # between enumeration and bind().
                    sock.bind((address, 0))
                    sock.setblocking(False)

                    network = IPv4Network(f"{address}/{netmask}", strict=False)

                    sockets.append((ifname, address, broadcast, network, sock))

                    logger.info("Broadcasting discovery on %s (%s) to %s", ifname, address, broadcast)

                    await loop.sock_sendto(sock, DISCOVERY_REQUEST, (broadcast, DISCOVERY_PORT))

                except OSError as exc:
                    logger.warning("Skipping discovery interface %s (%s): %s", ifname, address, exc)
                    sock.close()

            deadline = loop.time() + timeout

            while True:
                remaining = deadline - loop.time()

                if remaining <= 0:
                    break

                # Associate each receive task with the subnet of the
                # interface on which it is listening.
                receive_tasks = {asyncio.create_task(loop.sock_recvfrom(sock, 4096)): network for _, _, _, network, sock in sockets}

                if not receive_tasks:
                    break

                done, pending = await asyncio.wait(receive_tasks, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)

                # Cancel and await all pending receive operations before
                # closing their sockets.
                for task in pending:
                    task.cancel()

                await asyncio.gather(*pending, return_exceptions=True)

                if not done:
                    break

                for task in done:
                    network = receive_tasks[task]

                    try:
                        data, address = task.result()

                    except (asyncio.CancelledError, OSError):
                        continue

                    try:
                        peer = json.loads(data)

                        if not isinstance(peer, dict):
                            continue

                        peer["address"] = address[0]
                        peer["subnet"] = str(network)

                        peers.append(peer)

                    except (json.JSONDecodeError, TypeError):
                        continue

            unique = {(peer["address"], peer["port"]): peer for peer in peers}

            return list(unique.values())

        finally:
            for _, _, _, _, sock in sockets:
                sock.close()
