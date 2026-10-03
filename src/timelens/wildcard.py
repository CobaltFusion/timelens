#!/usr/bin/env python3

from __future__ import annotations

import re


def make_wildcard_matcher(pattern):
    """
    Returns a function that tests a text against 'pattern', case-insensitive, '*' matches anything.
    Without a '*' the pattern matches anywhere in the text, with a '*' it must match the whole text.
    Same semantics as 'makeWildcardMatcher' in the webclient.
    """
    lower_pattern = pattern.lower()

    if "*" not in lower_pattern:
        return lambda text: lower_pattern in text.lower()

    regex = re.compile(".*".join(re.escape(part) for part in lower_pattern.split("*")), re.DOTALL)
    return lambda text: regex.fullmatch(text.lower()) is not None
