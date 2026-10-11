@echo off
setlocal EnableExtensions

rem Install TimeLens in a separate process so environment changes do not leak.
set "REPOSITORY=https://github.com/CobaltFusion/timelens.git"
set "LOG_DIR=%TEMP%\logs\telemetry"
set "INSTALL_DIR="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="-i" goto directory
echo Error: unknown option %~1 1>&2
goto usage_error

:directory
if "%~2"=="" (
    echo Error: -i requires an installation directory. 1>&2
    goto usage_error
)
set "INSTALL_DIR=%~2"
shift
shift
goto parse

:parsed
if "%INSTALL_DIR%"=="" set "INSTALL_DIR=%TEMP%\timelens"

if exist "%INSTALL_DIR%" (
    echo Error: installation directory already exists: "%INSTALL_DIR%" 1>&2
    exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
    echo Error: Git is required but was not found in PATH. 1>&2
    exit /b 1
)

echo Cloning TimeLens into "%INSTALL_DIR%"...
git clone "%REPOSITORY%" "%INSTALL_DIR%"
if errorlevel 1 exit /b 1

echo Creating telemetry log directory...
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if errorlevel 1 exit /b 1

set "START_SCRIPT=%INSTALL_DIR%\start_timelens.bat"

if not exist "%START_SCRIPT%" (
    echo Error: startup script not found: "%START_SCRIPT%" 1>&2
    exit /b 1
)

echo Starting TimeLens...
pushd "%INSTALL_DIR%"
call "%START_SCRIPT%"
set "RESULT=%ERRORLEVEL%"
popd

exit /b %RESULT%

:usage_error
echo Usage: %~nx0 [-i install_dir] 1>&2
exit /b 2
