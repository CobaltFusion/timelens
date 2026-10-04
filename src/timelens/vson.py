#!/usr/bin/env python3
"""
The log files of the server: '*.vson' files with one Chrome trace event per line.
Shared by the server and the command line tools, so they read the files the same way.
"""

from __future__ import annotations

import json
from pathlib import Path

# The server watches the first folder that exists, the last one is the fallback.
LOG_DIRECTORIES = (Path("/tmp/logs/telemetry"), Path("c:/temp/logs/telemetry"))

LOG_SUFFIX = ".vson"


def default_log_directory():
    for directory in LOG_DIRECTORIES:
        if directory.is_dir():
            return directory
    return LOG_DIRECTORIES[-1]


def find_log_files(paths):
    """
    The '*.vson' files of 'paths', sorted. A path is a file, or a folder whose files are used.
    Raises FileNotFoundError for a path that does not exist.
    """
    files = []
    for path in map(Path, paths):
        if path.is_dir():
            files.extend(sorted(path.glob(f"*{LOG_SUFFIX}")))
        elif path.is_file():
            files.append(path)
        else:
            raise FileNotFoundError(f"no such file or folder: {path}")
    return files


def parse_line(line):
    """
    The event of a line of a log file, None for a line that has none (empty, or only a bracket).
    Raises ValueError for a line that is not a JSON object.

    The files are a JSON array that is never closed: the first line starts with '[' and every event
    is followed by a comma.
    """
    text = line.strip()
    if text.startswith("["):
        text = text[1:]
    if text.endswith(","):
        text = text[:-1]
    text = text.strip()
    if text in ("", "]"):
        return None

    event = json.loads(text)
    if not isinstance(event, dict):
        raise ValueError("an event must be a JSON object")
    return event
