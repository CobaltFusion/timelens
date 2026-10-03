#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
from pathlib import Path

# The profile the webclient loads when it is opened.
DEFAULT_PROFILE = "default"

DEFAULT_DIRECTORY = Path.home() / ".timelens" / "profiles"

# Letters, digits, space, '_', '.' and '-', starting with a letter or digit, so a name can not
# be a path ('/', '\\', '..') and is a valid file name on Windows and Linux.
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}")


class ProfileStore:
    """
    Stores settings profiles as '<name>.json' files in 'directory'.
    A profile is a JSON object, its content is up to the webclient.
    """

    def __init__(self, directory=DEFAULT_DIRECTORY):
        self.directory = Path(directory)

    @staticmethod
    def is_valid_name(name):
        return isinstance(name, str) and _NAME.fullmatch(name) is not None and not name.endswith((" ", "."))

    # sorted profile names
    def list(self):
        if not self.directory.is_dir():
            return []
        return sorted(path.stem for path in self.directory.glob("*.json") if self.is_valid_name(path.stem))

    # the profile, None if there is no profile with this name
    def load(self, name):
        try:
            with self._path(name).open("r", encoding="utf8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    # Writes to a temporary file first, so a profile is never left half written.
    def save(self, name, data):
        path = self._path(name)
        self.directory.mkdir(parents=True, exist_ok=True)

        fd, temp_path = tempfile.mkstemp(dir=self.directory, prefix=".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_path, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(temp_path)
            raise

    # True if the profile existed
    def delete(self, name):
        try:
            self._path(name).unlink()
            return True
        except FileNotFoundError:
            return False

    def _path(self, name):
        if not self.is_valid_name(name):
            raise ValueError(f"invalid profile name: {name!r}")
        return self.directory / f"{name}.json"

