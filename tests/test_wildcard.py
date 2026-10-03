#!/usr/bin/env python3

import pytest

from timelens.wildcard import make_wildcard_matcher


@pytest.mark.parametrize("pattern, text, expected", [
    ("err", "SomeError", True),         # without '*' the pattern matches anywhere
    ("ERR", "some_error", True),        # case-insensitive
    ("err", "warning", False),
    ("err*", "error_1", True),          # with '*' the whole text must match
    ("err*", "1_error", False),
    ("*err", "1_err", True),
    ("*err", "1_error", False),
    ("*err*", "1_error_2", True),
    ("a*c", "abc", True),
    ("a*c", "abcd", False),
    ("a*a", "a", False),
    ("1_*.x", "1_ab.x", True),          # regex characters are literal
    ("1_*.x", "1_abyx", False),
])
def test_wildcard_matcher(pattern, text, expected):
    assert make_wildcard_matcher(pattern)(text) == expected
