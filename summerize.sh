#!/usr/bin/env bash

set -e

SCRIPTDIR="$(realpath "$(dirname "$0")")"
cd "$SCRIPTDIR"

echo "Working directory: $PWD"

# Create venv if it doesn't exist
if [ ! -f "venv/bin/activate" ]; then
    echo "Creating virtual environment..."
    rm -rf venv
    python3 -m venv venv
    venv/bin/python -m pip install --upgrade pip
    venv/bin/python -m pip install -e ".[dev]"
fi

source venv/bin/activate
cd "$SCRIPTDIR/src/timelens"
echo "Moved to TimeLens directory: $PWD"

./summary.py "$@"
