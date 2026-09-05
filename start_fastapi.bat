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

:: Change to the script directory (and drive)
cd /d "%~dp0"

:: Handle "reinstall" argument
if /i "%~1"=="reinstall" (
    echo Reinstall requested.
    if exist "venv\" (
        echo Removing existing virtual environment...
        rmdir /s /q "venv"
        if errorlevel 1 exit /b %errorlevel%
    )
)

:: Create virtual environment if needed
if not exist "venv\" (
    echo Creating virtual environment...
    py -3.13 -m venv venv
    if errorlevel 1 exit /b %errorlevel%
)

call venv\Scripts\activate.bat
if errorlevel 1 exit /b %errorlevel%

echo Installing dependencies...
python -m pip install -e ".[dev]"
if errorlevel 1 exit /b %errorlevel%

python --version

cd /d "%~dp0src\timelens"

start http://localhost:8080

python -m uvicorn server:app --reload --host 0.0.0.0 --port 8080
