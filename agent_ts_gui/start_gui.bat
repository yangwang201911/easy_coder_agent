@echo off
rem Launch the Coder Agent GUI (Electron front-end + Python backend) on Windows.
rem Usage: start_gui.bat [--root C:\path\to\project] [--yes] [--proxy]
rem   --yes        answer every preflight question with its default
rem   --proxy      re-ask for a proxy (type the URL at the prompt)
rem
rem Preflight checks: proxy, GUI node deps, the Python backend venv.
rem In a console you are asked (default in [brackets]); when stdin is not a
rem console (dock / IDE button) set /p returns empty immediately, so all
rem defaults are used silently.
setlocal
cd /d "%~dp0" || exit /b 1

set "ASSUME_YES=0"
set "WANT_PROXY=0"
for %%A in (%*) do (
  if /i "%%~A"=="--yes" set "ASSUME_YES=1"
  if /i "%%~A"=="--proxy" set "WANT_PROXY=1"
)

set "CONF=%USERPROFILE%\.coder_agent\launcher.conf"
if exist "%CONF%" call "%CONF%"
set "PROXY=%PROXY%"
set "PY_TOOL=%PY_TOOL%"

rem --- 1. proxy (only relevant while the downloads below are still needed) ----
set "NEED_PROXY=0"
if not exist "gui\node_modules" set "NEED_PROXY=1"
if not exist "backend\.venv\Scripts\python.exe" set "NEED_PROXY=1"
if "%NEED_PROXY%"=="1" goto :ask_proxy
if "%WANT_PROXY%"=="1" goto :ask_proxy
goto :proxy_done
:ask_proxy
if "%ASSUME_YES%"=="1" goto :proxy_done
set "PNEW="
set /p "PNEW=Downloads may be needed. Proxy address, empty = none [%PROXY%]: " 2>nul
if defined PNEW set "PROXY=%PNEW%"
:proxy_done
if "%PROXY%" neq "" set "http_proxy=%PROXY%"
if "%PROXY%" neq "" set "https_proxy=%PROXY%"
if "%PROXY%" neq "" echo [start_gui] using proxy %PROXY% for downloads
if not exist "%USERPROFILE%\.coder_agent" mkdir "%USERPROFILE%\.coder_agent"
> "%CONF%" echo set proxy=%PROXY%
if "%PY_TOOL%" neq "" >> "%CONF%" echo set py_tool=%PY_TOOL%

rem --- 2. GUI node deps (Electron binary download needs the proxy) ---------
if exist "gui\node_modules" goto :node_done
if "%ASSUME_YES%"=="1" goto :node_install
set "ANS="
set /p "ANS=GUI node dependencies are missing, npm install downloads about 100MB including the Electron binary. Install now? [Y/n]: " 2>nul
if /i "%ANS%"=="N" goto :node_skip
:node_install
cd gui || goto :fail
call npm install
if errorlevel 1 goto :fail
cd /d "%~dp0"
goto :node_done
:node_skip
echo [start_gui] skipping npm install - the GUI cannot start without node_modules
exit /b 1
:node_done

rem --- 3. Python backend venv (the GUI spawns backend\.venv\Scripts\python) -
if exist "backend\.venv\Scripts\python.exe" goto :venv_done
set "HAVE_UV=0"
where uv >nul 2>&1
if not errorlevel 1 set "HAVE_UV=1"
if "%PY_TOOL%"=="" if "%HAVE_UV%"=="1" if "%ASSUME_YES%"=="0" set /p "TNEW=Create the Python venv for the backend. uv is fast and detected, pip is slower. Which? [uv/pip]: "
if "%PY_TOOL%"=="" if defined TNEW set "PY_TOOL=%TNEW%"
if "%PY_TOOL%"=="" if "%HAVE_UV%"=="1" set "PY_TOOL=uv"
if "%PY_TOOL%"=="" set "PY_TOOL=pip"
if /i "%PY_TOOL%"=="uv" goto :venv_uv
echo [start_gui] creating venv with py -m venv + pip, slower than uv
cd backend || goto :fail
py -m venv .venv || goto :fail
.venv\Scripts\python.exe -m pip install -e . || goto :fail
cd /d "%~dp0"
goto :venv_saved
:venv_uv
cd backend || goto :fail
uv sync || goto :fail
cd /d "%~dp0"
:venv_done
rem deps changed since the venv was created? uv sync is a fast no-op when current.
where uv >nul 2>&1
if errorlevel 1 goto :venv_saved
cd backend || goto :venv_saved
uv sync
cd /d "%~dp0"
:venv_saved
if not exist "%USERPROFILE%\.coder_agent" mkdir "%USERPROFILE%\.coder_agent"
> "%CONF%" echo set proxy=%PROXY%
>> "%CONF%" echo set py_tool=%PY_TOOL%

rem --- 4. Playwright Chromium, the headless browser for the browser tools ---
rem About 150MB. Without it the browser tools are disabled, everything else works.
if exist "backend\.venv\Scripts\python.exe" if not exist "%LOCALAPPDATA%\ms-playwright" echo [start_gui] hint: browser tools need Chromium, install with: cd backend ^&^& .venv\Scripts\python.exe -m playwright install chromium

rem --- build + launch --------------------------------------------------------
cd gui || goto :fail
call npm run build
if errorlevel 1 goto :build_failed
if not exist "node_modules\.bin\electron.cmd" goto :electron_missing
if not exist "dist\main\index.js" goto :build_missing
rem Pass the app as an ABSOLUTE path: electron's "Unable to find Electron app
rem at ..." dialog appears when the relative "." does not resolve to this dir.
node_modules\.bin\electron.cmd --disable-gpu "%CD%" %*
exit /b

:build_failed
echo [start_gui] build failed - fix the errors above
exit /b 1

:electron_missing
echo [start_gui] electron not found: run "npm install" in gui\ first
exit /b 1

:build_missing
echo [start_gui] build output missing, dist\main\index.js - check the build output above
exit /b 1

:fail
echo [start_gui] preflight failed, see the error above
exit /b 1
