#!/usr/bin/env python3

import asyncio
import logging

from peer_discovery import PeerDiscovery

HTTP_PORT = 8080


async def main():
    discovery = PeerDiscovery(HTTP_PORT)

    await discovery.start()

    try:
        print("Listening for peer discovery...")
        print("Press Ctrl+C to stop.")
        await asyncio.Event().wait()

    finally:
        await discovery.stop()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="LISTENER: %(asctime)s %(levelname)s %(message)s")

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
