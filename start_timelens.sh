#!/usr/bin/env bash

set -e

SCRIPTDIR="$(realpath "$(dirname "$0")")"
cd "$SCRIPTDIR"

echo "Working directory: $PWD"

if ! python3 -m venv --help >/dev/null 2>&1; then
    echo "ERROR: Python venv support is not installed."
    echo "Please install it with:"
    echo "    sudo apt install python3-venv python3-pip"
    exit 1
fi

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

python3 --version
exec uvicorn server:app --reload --host 0.0.0.0 --port 8080
