#!/usr/bin/env bash

SCRIPTDIR=$(realpath $(dirname $0))
cd $SCRIPTDIR

set -e  # stop if anything fails

# 1. Create venv (only if it doesn't exist)
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi

# 2. Activate venv
source venv/bin/activate

# 3. Upgrade pip
pip install --upgrade pip

# 4. Install dependencies from pyproject.toml
pip install .

# 5. Start the app
exec uvicorn server:app --reload --host 0.0.0.0 --port 8080
