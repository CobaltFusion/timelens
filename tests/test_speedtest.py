#!/usr/bin/env python3

import asyncio

import pytest

from timelens.speedtest import BLOCK, MAX_BYTES, MEGABYTE, TooLarge, count_upload, cors_headers, download_chunks, parse_bytes


def test_a_megabyte_is_1024_times_1024_bytes():
    assert MEGABYTE == 1_048_576
    assert MAX_BYTES == 256 * 1_048_576


@pytest.mark.parametrize("text, expected", [("1", 1), ("1048576", MEGABYTE), (str(MAX_BYTES), MAX_BYTES), (" 5 ", 5)])
def test_parse_bytes(text, expected):
    assert parse_bytes(text) == expected


@pytest.mark.parametrize("text", [None, "", "abc", "1.5", "0", "-1", str(MAX_BYTES + 1), "1e6"])
def test_parse_bytes_refuses_what_is_not_a_size(text):
    with pytest.raises(ValueError):
        parse_bytes(text)


@pytest.mark.parametrize("total", [1, 100, len(BLOCK) - 1, len(BLOCK), len(BLOCK) + 1, 3 * len(BLOCK), 3 * len(BLOCK) + 7, MEGABYTE])
def test_a_download_has_exactly_the_bytes_that_were_asked(total):
    chunks = list(download_chunks(total))

    assert sum(len(chunk) for chunk in chunks) == total
    assert all(chunks)      # no empty chunks


def test_the_data_cannot_be_compressed():
    assert len(set(BLOCK)) > 200        # random bytes, not zeros or a pattern


def test_nothing_to_download_gives_no_chunks():
    assert list(download_chunks(0)) == []


async def chunks_of(*sizes):
    for size in sizes:
        yield b"x" * size


def test_count_upload():
    assert asyncio.run(count_upload(chunks_of(10, 20, 5))) == 35
    assert asyncio.run(count_upload(chunks_of())) == 0


def test_an_upload_that_is_too_large_is_refused_before_it_is_read_completely():
    read = []

    async def stream():
        for i in range(1000):
            read.append(i)
            yield b"x" * 10

    with pytest.raises(TooLarge):
        asyncio.run(count_upload(stream(), limit=95))

    assert len(read) == 10      # the tenth chunk went over the limit, the others were never read


def test_cors_headers_only_for_the_speed_test():
    assert cors_headers("/api/speedtest/ping", "GET") == {"Access-Control-Allow-Origin": "*"}
    assert cors_headers("/api/speedtest/upload", "POST") == {"Access-Control-Allow-Origin": "*"}
    for path in ("/api/profiles", "/api/profiles/default", "/api/servers", "/graph.html", "/", "/api/speedtest"):
        assert cors_headers(path, "GET") == {}
        assert cors_headers(path, "OPTIONS") == {}


def test_the_preflight_of_an_upload_is_answered():
    headers = cors_headers("/api/speedtest/upload", "OPTIONS")

    assert headers["Access-Control-Allow-Origin"] == "*"
    assert "POST" in headers["Access-Control-Allow-Methods"]
    assert "Content-Type" in headers["Access-Control-Allow-Headers"]
    assert headers["Access-Control-Allow-Private-Network"] == "true"
