#!/usr/bin/env python3
"""
What the server needs for the speed test page: data to download, a body to count for the upload, and the
CORS headers, so a page from one machine can measure another machine directly from the browser.

All sizes are in megabytes of 1024 * 1024 bytes.
"""

from __future__ import annotations

import os

MEGABYTE = 1024 * 1024

# the most that one download or upload may be
MAX_BYTES = 256 * MEGABYTE

# The paths of the speed test, the only ones that other origins may use.
PATH_PREFIX = "/api/speedtest/"

# The data that is sent. It is random so it can not be compressed on the way, and made once so no time is
# spent making it while it is sent.
BLOCK = os.urandom(64 * 1024)


class TooLarge(Exception):
    """An upload that is bigger than the limit."""


def parse_bytes(text):
    """The number of bytes of a request, a whole number from 1 to MAX_BYTES. Raises ValueError for anything else."""
    try:
        number = int(text)
    except (TypeError, ValueError):
        raise ValueError(f"not a whole number: {text!r}") from None
    if not 1 <= number <= MAX_BYTES:
        raise ValueError(f"the number of bytes must be from 1 to {MAX_BYTES}, not {number}")
    return number


def download_chunks(total):
    """The chunks of a download of exactly 'total' bytes."""
    remaining = total
    while remaining > 0:
        if remaining >= len(BLOCK):
            yield BLOCK
            remaining -= len(BLOCK)
        else:
            yield BLOCK[:remaining]
            remaining = 0


async def count_upload(stream, limit=MAX_BYTES):
    """
    The number of bytes in the body of an upload, 'stream' gives its chunks.
    Raises TooLarge as soon as it is more than 'limit', the rest is not read.
    """
    count = 0
    async for chunk in stream:
        count += len(chunk)
        if count > limit:
            raise TooLarge(f"more than {limit} bytes")
    return count


def cors_headers(path, method):
    """
    The headers that let a page from another origin use the speed test, none for any other path:
    the profiles and the rest of the API stay for the page of the server itself.
    The 'OPTIONS' request that a browser makes before an upload from another origin gets the extra ones.
    """
    if not path.startswith(PATH_PREFIX):
        return {}

    headers = {"Access-Control-Allow-Origin": "*"}
    if method == "OPTIONS":
        headers.update({
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
            "Access-Control-Allow-Private-Network": "true",
        })
    return headers
