#!/usr/bin/env python3

from __future__ import annotations

import re

from timelens.wildcard import make_wildcard_matcher

FIELDS = ("name", "cat", "source", "pid", "tid")
MATCHES = ("normal", "regex")
TYPES = ("include", "exclude", "color")

_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


class EventFilter:
    """
    Decides which spans a client gets, and which color is forced on them.

    A rule is a dict: field (name, cat, source, pid, tid), pattern, match ('normal' is the
    wildcard matching of the trigger word, 'regex' a regular expression, both case-insensitive),
    type (include, exclude, color) and color ('#rrggbb', only for color rules).

    Include rules are OR-ed, without include rules every span is included.
    A matching exclude rule takes precedence over all include rules.
    The first matching color rule decides the color, color rules do not affect inclusion.
    """

    def __init__(self, rules=()):
        self.includes = []
        self.excludes = []
        self.colors = []    # [(test, color)]

        for number, rule in enumerate(rules, start=1):
            try:
                self._add(rule)
            except (TypeError, ValueError, re.error) as exc:
                raise ValueError(f"rule {number}: {exc}") from None

    def is_empty(self):
        return not (self.includes or self.excludes or self.colors)

    def accepts(self, span):
        if any(test(span) for test in self.excludes):
            return False
        return not self.includes or any(test(span) for test in self.includes)

    def color_of(self, span):
        for test, color in self.colors:
            if test(span):
                return color
        return None

    def _add(self, rule):
        if not isinstance(rule, dict):
            raise TypeError("a rule must be an object")

        pattern = rule.get("pattern") or ""
        if not isinstance(pattern, str):
            raise TypeError("the pattern must be text")
        if not pattern:
            return  # an empty row in the editor

        field = rule.get("field", "name")
        match = rule.get("match", "normal")
        rule_type = rule.get("type", "include")
        if field not in FIELDS:
            raise ValueError(f"unknown field {field!r}")
        if match not in MATCHES:
            raise ValueError(f"unknown match {match!r}")
        if rule_type not in TYPES:
            raise ValueError(f"unknown type {rule_type!r}")

        if match == "regex":
            try:
                matcher = re.compile(pattern, re.IGNORECASE).search
            except re.error as exc:
                raise ValueError(f"invalid regex: {exc}") from None
        else:
            matcher = make_wildcard_matcher(pattern)

        # pid and tid are numbers, they are matched as text
        def test(span):
            value = span.get(field)
            return bool(matcher("" if value is None else str(value)))

        if rule_type == "include":
            self.includes.append(test)
        elif rule_type == "exclude":
            self.excludes.append(test)
        else:
            color = rule.get("color")
            if not isinstance(color, str) or not _COLOR.fullmatch(color):
                raise ValueError(f"invalid color {color!r}, expected '#rrggbb'")
            self.colors.append((test, color))
