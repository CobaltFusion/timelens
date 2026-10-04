@echo off
setlocal

:: Builds a copy of the web client with obfuscated JavaScript in dist\webclient.
::
:: The web client is made of ES modules. Concatenating the files does not work for modules, so each page
:: is bundled into one module with esbuild first, and that bundle is obfuscated. The pages load the
:: result with <script type="module">, under the same file name as the source, so the html is copied as is.

:: Change to the script directory (and drive)
cd /d "%~dp0"

set SRC=src\timelens\webclient
set BUNDLE=dist\bundle
set OUT=dist\webclient
set ESBUILD=node_modules\.bin\esbuild.cmd
set OBFUSCATOR=node_modules\.bin\javascript-obfuscator.cmd

:: esbuild and javascript-obfuscator are dev dependencies, see package.json
if not exist "%ESBUILD%" call npm install
if not exist "%OBFUSCATOR%" call npm install
if not exist "%ESBUILD%" exit /b 1
if not exist "%OBFUSCATOR%" exit /b 1

:: start from empty folders
if exist dist rmdir /s /q dist
mkdir "%BUNDLE%"
mkdir "%OUT%"

:: One module per page, the entry points are the scripts of graph.html and index.html.
call "%ESBUILD%" "%SRC%\graph_main.js" "%SRC%\index.js" --bundle --format=esm --target=es2022 --outdir="%BUNDLE%"
if errorlevel 1 exit /b 1

:: Obfuscates a bundle, the result has the same name in the web client folder.
call "%OBFUSCATOR%" "%BUNDLE%\graph_main.js" --output "%OUT%\graph_main.js" --compact true --control-flow-flattening true --dead-code-injection true
if errorlevel 1 exit /b 1
call "%OBFUSCATOR%" "%BUNDLE%\index.js" --output "%OUT%\index.js" --compact true --control-flow-flattening true --dead-code-injection true
if errorlevel 1 exit /b 1

:: everything that is not JavaScript is used as is
copy /y "%SRC%\*.html" "%OUT%" >nul
copy /y "%SRC%\*.css" "%OUT%" >nul
copy /y "%SRC%\favicon.ico" "%OUT%" >nul

rmdir /s /q "%BUNDLE%"

echo.
echo Built %OUT%
echo The server serves the folder 'webclient' of its working directory, to try this build run from dist:
echo     cd dist ^&^& ..\venv\Scripts\python -m uvicorn server:app --app-dir ..\src\timelens --port 8080
