#!/usr/bin/env python3

import asyncio
import logging

from peer_discovery import PeerDiscovery


async def main():
    discovery = PeerDiscovery(0)

    print("Discovering peers...")

    peers = await discovery.discover(timeout=1.0)

    if not peers:
        print("No peers found.")
        return

    print()
    print("Peers:")

    for peer in peers:
        print(f"  {peer['name']:20} {peer['address']}:{peer['port']}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="SENDER: %(asctime)s %(levelname)s %(message)s")

    asyncio.run(main())
