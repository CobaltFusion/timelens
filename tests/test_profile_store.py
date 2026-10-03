#!/usr/bin/env python3

import pytest

from timelens.profile_store import ProfileStore


def test_save_and_load(tmp_path):
    store = ProfileStore(tmp_path / "profiles")
    profile = {"version": 1, "graphs": [{"triggerWord": "é*"}]}

    store.save("work", profile)

    assert store.load("work") == profile
    assert (tmp_path / "profiles" / "work.json").is_file()


def test_load_missing_is_none(tmp_path):
    assert ProfileStore(tmp_path).load("missing") is None


def test_list_is_sorted_and_only_profiles(tmp_path):
    store = ProfileStore(tmp_path)
    store.save("b", {})
    store.save("A 1", {})
    (tmp_path / "notes.txt").write_text("x")
    (tmp_path / ".x.tmp").write_text("x")

    assert store.list() == ["A 1", "b"]


def test_list_without_directory_is_empty(tmp_path):
    assert ProfileStore(tmp_path / "missing").list() == []


def test_overwrite_replaces_content(tmp_path):
    store = ProfileStore(tmp_path)
    store.save("p", {"a": 1})
    store.save("p", {"b": 2})

    assert store.load("p") == {"b": 2}
    assert list(tmp_path.iterdir()) == [tmp_path / "p.json"]   # no temporary files left


def test_delete(tmp_path):
    store = ProfileStore(tmp_path)
    store.save("p", {})

    assert store.delete("p") is True
    assert store.delete("p") is False
    assert store.list() == []


@pytest.mark.parametrize("name", ["", "../x", "a/b", "a\b", ".hidden", "x" * 65, "trailing.", "trailing ", "a:b"])
def test_invalid_names_are_refused(tmp_path, name):
    store = ProfileStore(tmp_path)

    assert not store.is_valid_name(name)
    with pytest.raises(ValueError):
        store.save(name, {})
    with pytest.raises(ValueError):
        store.load(name)
    with pytest.raises(ValueError):
        store.delete(name)
