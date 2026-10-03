#!/usr/bin/env python3

import pytest

from timelens.event_filter import EventFilter


def span(name, **extra):
    return {"name": name, "cat": "loop", "source": "a.vson", "pid": 123, "tid": 345, **extra}


def rule(pattern, type="include", match="normal", field="name", color=None):
    return {"pattern": pattern, "type": type, "match": match, "field": field, "color": color}


def accepted(event_filter, *names):
    return [name for name in names if event_filter.accepts(span(name))]


def test_no_rules_accepts_all():
    event_filter = EventFilter([])
    assert event_filter.is_empty()
    assert accepted(event_filter, "a", "b") == ["a", "b"]


def test_includes_are_ored():
    event_filter = EventFilter([rule("pre"), rule("post")])
    assert accepted(event_filter, "1_pre", "1_error", "1_post") == ["1_pre", "1_post"]


def test_exclude_takes_precedence_over_include():
    event_filter = EventFilter([rule("1_*"), rule("error", "exclude")])
    assert accepted(event_filter, "1_pre", "1_error", "2_pre") == ["1_pre"]


def test_exclude_alone_keeps_the_rest():
    event_filter = EventFilter([rule("error", "exclude")])
    assert accepted(event_filter, "pre", "error", "post") == ["pre", "post"]


def test_first_color_rule_wins():
    event_filter = EventFilter([
        rule("error", "color", color="#ff0000"),
        rule("*", "color", color="#00ff00"),
    ])
    assert event_filter.color_of(span("1_error")) == "#ff0000"
    assert event_filter.color_of(span("pre")) == "#00ff00"


def test_color_rule_does_not_affect_inclusion():
    event_filter = EventFilter([rule("pre"), rule("error", "color", color="#ff0000")])
    assert accepted(event_filter, "pre", "error") == ["pre"]
    assert EventFilter([rule("error", "color", color="#ff0000")]).color_of(span("pre")) is None


def test_regex_and_normal_ignore_case():
    assert accepted(EventFilter([rule(r"^\d+_ERR", match="regex")]), "12_error", "x12_error") == ["12_error"]
    assert accepted(EventFilter([rule("ERR")]), "some_error", "pre") == ["some_error"]
    # in normal mode regex characters are literal
    assert accepted(EventFilter([rule("a.c")]), "a.c", "abc") == ["a.c"]


def test_other_fields_match_as_text():
    assert EventFilter([rule("345", field="tid")]).accepts(span("x"))
    assert not EventFilter([rule("346", field="tid")]).accepts(span("x"))
    assert EventFilter([rule("^12", match="regex", field="pid")]).accepts(span("x"))
    assert not EventFilter([rule("a.vson", "exclude", field="source")]).accepts(span("x"))
    assert EventFilter([rule("loop", field="cat")]).accepts(span("x"))


def test_missing_field_is_empty_text():
    assert not EventFilter([rule("loop", field="cat")]).accepts({"name": "x"})


def test_empty_patterns_are_ignored():
    event_filter = EventFilter([rule(""), rule("", "exclude")])
    assert event_filter.is_empty()
    assert accepted(event_filter, "a") == ["a"]


@pytest.mark.parametrize("bad_rule, message", [
    (rule("(", match="regex"), "invalid regex"),
    (rule("x", "color", color="red"), "invalid color"),
    (rule("x", "color"), "invalid color"),
    (rule("x", field="host"), "unknown field"),
    (rule("x", type="highlight"), "unknown type"),
    (rule("x", match="glob"), "unknown match"),
    ("x", "must be an object"),
])
def test_invalid_rules_name_the_rule(bad_rule, message):
    with pytest.raises(ValueError, match=f"rule 2: .*{message}"):
        EventFilter([rule("ok"), bad_rule])
