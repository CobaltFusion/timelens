:: ## FastAPI is a Python web framework designed for building fast and efficient backend APIs
::
:: Running a FastAPI python application on uvicorn allows you to serve Websockets and static content efficiently. (among many other things)
::
::  FastAPI is built on top of Starlette, a lightweight ASGI framework that handles the core HTTP operations,
::  including routing, middleware, and WebSockets support. Starlette provides the low-level tools that FastAPI uses to manage HTTP requests,
::  making it a stable and performant foundation for building web applications
::
:: ## Uvicorn is a lightning-fast ASGI server, optimized for handling asynchronous code. It's essential for running FastAPI applications
::    because it handles incoming HTTP requests and manages the lifecycle of these requests
::
:: `pip install "fastapi[all]"` to include documentation and validation tools

:: To setup a local isolated test environment:
::
:: python3 -m venv timelens-venv
:: source timelens-venv/bin/activate
:: pip install fastapi
:: pip install gunicorn

@echo off
setlocal

:: change to the script directory (and drive)
cd /d "%~dp0"

if not exist "venv\" (
    echo Creating virtual environment...
    py -3.13 -m venv venv
    if errorlevel 1 exit /b %errorlevel%

    call venv\Scripts\activate.bat

    echo Installing dependencies...
    python -m pip install --upgrade pip
    python -m pip install -e .
    python -m pip install -e ".[dev]"
) else (
    call venv\Scripts\activate.bat
)

python --version

cd /d "%~dp0"\src\timelens
start http://localhost:8080

::  server -> refers to the file server.py
::  app    -> refers to the variable 'app' in 'server.py' that is the main entrypoint for the application
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8080
