@echo off
rem Regression suite for Coder Agent on Windows: backend pytest + GUI CDP smoke tests.
rem Usage:
rem   run_tests.bat            everything
rem   run_tests.bat backend    backend pytest only
rem   run_tests.bat gui        all GUI CDP tests
rem   run_tests.bat remote     remote test (needs a standalone server on 127.0.0.1:8931)
rem   run_tests.bat <name>     one GUI test by name (boot, theme, split, proj, ...)
setlocal
cd /d "%~dp0"

set TARGET=%1
if "%TARGET%"=="" set TARGET=all
set FAILED=

if "%TARGET%"=="all" call :run_backend
if "%TARGET%"=="backend" goto summary
if "%TARGET%"=="all" (
  call :run_gui
  goto summary
)

rem single GUI suite name (boot, theme, split, proj, ...) - run_all_tests.cjs
rem auto-discovers every cdp_*_test.cjs, so no list is kept here
call :run_gui %TARGET%
goto summary

:run_backend
echo === backend pytest ===
call .venv\Scripts\python -m pytest tests\ -q
if errorlevel 1 set FAILED=%FAILED% backend
exit /b 0

:run_gui
echo === gui: %1 ===
pushd gui\tests\e2e
call node run_all_tests.cjs %1
if errorlevel 1 set FAILED=%FAILED% %1
popd
exit /b 0

:summary
echo.
if "%FAILED%"=="" (
  echo ALL TESTS PASSED
  exit /b 0
) else (
  echo FAILED:%FAILED%
  exit /b 1
)
