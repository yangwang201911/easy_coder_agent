@echo off
rem Build the Windows NSIS installer for the Coder Agent GUI.
rem Requirements: Node 20+ and a venv at backend\.venv
rem   (PyInstaller is a build-time tool; it is auto-installed below if missing,
rem    same as release.sh)
rem Run from an ELEVATED (administrator) prompt: electron-builder unpacks its
rem winCodeSign tooling with 7-Zip, which creates symbolic links that a normal
rem user cannot make ("Cannot create symbolic link : A required privilege is
rem not held by the client"). Alternatively enable Windows Developer Mode.
setlocal
cd /d "%~dp0"

echo ==^> building backend standalone executable
rem PyInstaller is a build-time tool, not a runtime dependency, so it may be
rem missing from a freshly created venv - install it automatically (as release.sh does).
backend\.venv\Scripts\python -m PyInstaller --version >nul 2^>^&1
if errorlevel 1 (
  echo PyInstaller not found in backend\.venv, installing...
  backend\.venv\Scripts\python -m pip install pyinstaller
  if errorlevel 1 exit /b 1
)
backend\.venv\Scripts\python backend\build_standalone.py gui\build-resources\backend
if errorlevel 1 exit /b 1

echo ==^> building GUI (electron-builder)
cd gui
rem make sure npm dependencies are present and up to date (a branch switch
rem updates package.json but not node_modules; esbuild then fails with
rem "Could not resolve ..." for the new packages). NOTE: no multi-line
rem "if (...) (...)" blocks here - cmd.exe mis-parses them (see the
rem windows-linux-scripts skill); use labels instead.
rem NOTE: staleness is judged against node_modules/.package-lock.json, NOT
rem node_modules itself - npm install rewrites the dir mtime, so a missing
rem package (e.g. ssh2 added on a branch switch) would go unnoticed and the
rem asar would ship without it ("Cannot find module 'ssh2'" at startup).
node -e "const fs=require('fs');const m=p=>fs.existsSync(p)?fs.statSync(p).mtimeMs:0;if(m('node_modules/.package-lock.json')===0||Math.max(m('package.json'),m('package-lock.json'))>m('node_modules/.package-lock.json'))process.exit(1)"
if errorlevel 1 goto :deps_stale
goto :deps_ok
:deps_stale
echo node_modules is missing or stale, running npm install...
rem skip electron's postinstall (it downloads from GitHub, which times out
rem on restricted networks); the npmmirror fallback below handles the binary.
set ELECTRON_SKIP_BINARY_DOWNLOAD=1
call npm install
if errorlevel 1 exit /b 1
set ELECTRON_SKIP_BINARY_DOWNLOAD=
:deps_ok
rem electron binary: its postinstall downloads from GitHub, which fails on
rem restricted networks. If it is missing, fetch it from npmmirror ourselves
rem (curl.exe and tar ship with Windows 10+).
if exist "node_modules\electron\dist\electron.exe" goto :electron_ok
echo electron binary missing, downloading from npmmirror...
for /f "delims=" %%v in ('node -p "require('./node_modules/electron/package.json').version"') do set ELEC_VER=%%v
curl.exe -L --retry 5 -o "%TEMP%\electron.zip" "https://cdn.npmmirror.com/binaries/electron/v%ELEC_VER%/electron-v%ELEC_VER%-win32-x64.zip"
if errorlevel 1 goto :elec_fail
if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist"
tar -xf "%TEMP%\electron.zip" -C "node_modules\electron\dist"
if errorlevel 1 goto :elec_fail
if exist "node_modules\electron\dist\electron.d.ts" move /Y "node_modules\electron\dist\electron.d.ts" "node_modules\electron\electron.d.ts" >nul
<nul set /p=electron.exe> "node_modules\electron\path.txt"
if not exist "node_modules\electron\dist\electron.exe" goto :elec_fail
goto :electron_ok
:elec_fail
echo ERROR: electron download/extraction failed.
echo Download it manually (see README "China / restricted network") and re-run release.bat.
exit /b 1
:electron_ok
call npm run dist:win
if errorlevel 1 exit /b 1

echo ==^> collecting server artifact
cd ..
for /f "delims=" %%v in ('node -p "require('./gui/package.json').version"') do set VER=%%v
rem unpacked runnable binary (release\coder-agent-<ver>-win)
if exist "release\coder-agent-%VER%-win" rmdir /s /q "release\coder-agent-%VER%-win"
move "release\win-unpacked" "release\coder-agent-%VER%-win" >nul
copy gui\build-resources\backend\coder-agent-server.exe "release\coder-agent-server-%VER%.win.exe"
rem server launcher: background start, idempotent, supports "stop".
rem NOTE: do NOT wrap these echo lines in a "( ... )" block - cmd's block
rem parser chokes on the parens the launcher itself contains and dies with
rem ". was unexpected at this time." (see windows-linux-scripts skill).
rem Plain echo lines with per-line redirection are safe.
:gen_server_launcher
echo @echo off> "release\coder-agent-server.bat"
echo rem Coder Agent server launcher (Windows, background).>> "release\coder-agent-server.bat"
echo rem Usage:>> "release\coder-agent-server.bat"
echo rem   coder-agent-server.bat [start] [port] [token]   start in background (default)>> "release\coder-agent-server.bat"
echo rem   coder-agent-server.bat stop                     stop the running server>> "release\coder-agent-server.bat"
echo rem then in the GUI: Settings ^> Connection ^> mode "remote", host, port, token.>> "release\coder-agent-server.bat"
echo setlocal>> "release\coder-agent-server.bat"
echo cd /d "%%~dp0">> "release\coder-agent-server.bat"
echo set BIN=coder-agent-server-%VER%.win.exe>> "release\coder-agent-server.bat"
echo set PIDFILE=coder-agent-server.pid>> "release\coder-agent-server.bat"
echo if "%%1"=="" goto start>> "release\coder-agent-server.bat"
echo if "%%1"=="stop" goto stop>> "release\coder-agent-server.bat"
echo if "%%1"=="start" goto start>> "release\coder-agent-server.bat"
echo usage: coder-agent-server.bat [start [port] [token] ^| stop]>> "release\coder-agent-server.bat"
echo exit /b 1>> "release\coder-agent-server.bat"
echo :stop>> "release\coder-agent-server.bat"
echo if exist "%%PIDFILE%%" (>> "release\coder-agent-server.bat"
echo   for /f "usebackq delims=" %%p in ("%%PIDFILE%%") do set PID=%%p>> "release\coder-agent-server.bat"
echo   tasklist /FI "PID eq %%PID%%" 2^>nul ^| findstr /I "%%BIN%%" ^>nul>> "release\coder-agent-server.bat"
echo   if not errorlevel 1 (>> "release\coder-agent-server.bat"
echo     taskkill /F /PID %%PID%% ^>nul>> "release\coder-agent-server.bat"
echo     del "%%PIDFILE%%">> "release\coder-agent-server.bat"
echo     echo coder-agent-server stopped>> "release\coder-agent-server.bat"
echo     exit /b 0>> "release\coder-agent-server.bat"
echo   )>> "release\coder-agent-server.bat"
echo )>> "release\coder-agent-server.bat"
echo del "%%PIDFILE%%" 2^>nul>> "release\coder-agent-server.bat"
echo echo coder-agent-server not running>> "release\coder-agent-server.bat"
echo exit /b 0>> "release\coder-agent-server.bat"
echo :start>> "release\coder-agent-server.bat"
echo if exist "%%PIDFILE%%" (>> "release\coder-agent-server.bat"
echo   for /f "usebackq delims=" %%p in ("%%PIDFILE%%") do set PID=%%p>> "release\coder-agent-server.bat"
echo   tasklist /FI "PID eq %%PID%%" 2^>nul ^| findstr /I "%%BIN%%" ^>nul>> "release\coder-agent-server.bat"
echo   if not errorlevel 1 (>> "release\coder-agent-server.bat"
echo     echo coder-agent-server already running (pid %%PID%%); one server per machine, use "stop" first 1^>^&2>> "release\coder-agent-server.bat"
echo     exit /b 1>> "release\coder-agent-server.bat"
echo   )>> "release\coder-agent-server.bat"
echo )>> "release\coder-agent-server.bat"
echo set PORT=%%2>> "release\coder-agent-server.bat"
echo if "%%PORT%%"=="" set PORT=8931>> "release\coder-agent-server.bat"
echo set TOKEN=%%3>> "release\coder-agent-server.bat"
echo if "%%TOKEN%%"=="" if exist "%%~dp0coder-agent-server.token" (>> "release\coder-agent-server.bat"
echo   set /p TOKEN=<"%%~dp0coder-agent-server.token">> "release\coder-agent-server.bat"
echo )>> "release\coder-agent-server.bat"
echo if "%%TOKEN%%"=="" (>> "release\coder-agent-server.bat"
echo   for /f %%t in ('powershell -NoProfile -Command "('{0:x16}' -f (Get-Random))"') do set TOKEN=%%t>> "release\coder-agent-server.bat"
echo   echo %%TOKEN%%>"%%~dp0coder-agent-server.token">> "release\coder-agent-server.bat"
echo   echo generated a new token (saved to %%~dp0coder-agent-server.token)>> "release\coder-agent-server.bat"
echo )>> "release\coder-agent-server.bat"
echo set ARGS=--host 0.0.0.0 --port %%PORT%% --token %%TOKEN%%>> "release\coder-agent-server.bat"
echo for /f "tokens=2 delims=:" %%p in ('wmic process call create "%%~dp0%%BIN%% %%ARGS%%" ^| findstr "ProcessId "') do (>> "release\coder-agent-server.bat"
echo   echo %%p^>%%PIDFILE%%>> "release\coder-agent-server.bat"
echo   echo coder-agent-server started (pid %%p^)>> "release\coder-agent-server.bat"
echo )>> "release\coder-agent-server.bat"
goto :after_server_launcher
:after_server_launcher
rem plain-name launcher so customers can just double-click "coder-agent"
(
echo @echo off
echo start "" "%%~dp0coder-agent-%VER%-win\coder-agent.exe"
) > "release\coder-agent.bat"
rem systemd unit for the Linux server machine (GUI on Windows + server on Linux)
copy /y deploy\coder-agent-server.service "release\coder-agent-server.service" >nul
rem usage guide for the end user
copy /y docs\release-guide.md "release\guide.txt" >nul

echo ==^> done, artifacts in release\
dir release
