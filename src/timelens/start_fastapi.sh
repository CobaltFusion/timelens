#!/usr/bin/env bash

set -e  # stop if anything fails

# 1. Create venv (only if it doesn't exist)
if [ ! -d "timelens-venv" ]; then
  python3 -m venv timelens-venv
fi

# 2. Activate venv
source timelens-venv/bin/activate

# 3. Upgrade pip
pip install --upgrade pip

# 4. Install dependencies
pip install fastapi uvicorn

# 5. Start the app
exec uvicorn server:app --reload --port 8080
