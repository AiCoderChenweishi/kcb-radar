@echo off
rem ============================================================
rem  STAR-Market Radar - Web dashboard launcher (LAN enabled)
rem
rem  NOTE: keep this file PURE ASCII. cmd.exe reads .cmd files with
rem  the OEM codepage (936 on zh-CN), so UTF-8 Chinese comments get
rem  misparsed and break the script (exit code 9009).
rem
rem  Why a launcher script instead of "node src\server.js" directly:
rem   1) LAN access needs RADAR_HOST=0.0.0.0 (default 127.0.0.1 = local only)
rem   2) Once listening on 0.0.0.0, the WRITE endpoint
rem      (POST /api/collect) must require RADAR_WRITE_TOKEN via the
rem      X-Radar-Token header, otherwise anyone on the LAN could
rem      trigger a full collection (burns API quota).
rem   3) The token lives in one place: data\radar.env
rem
rem  Changes 2026-10-27 (after the silent wedge of 2026-10-27 13:23):
rem   A) Kill whatever still holds the port before starting.
rem      A wedged old server kept the port but answered no HTTP at all,
rem      and the new instance then quit on EADDRINUSE with exit code 0
rem      -> the scheduled task reported "success" while the board was dead.
rem   B) Health check with a REAL HTTP request, not netstat.
rem      netstat only proves the socket is listening, not that the
rem      server still answers requests. A wedged server passes netstat.
rem
rem  To change config: edit data\radar.env, then restart the
rem  MavisKcbRadarWeb scheduled task.
rem ============================================================
setlocal
set "WEB_DIR=%~dp0.."
set "ENV_FILE=%WEB_DIR%data\radar.env"

if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

if "%RADAR_HOST%"=="" set "RADAR_HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=7788"

echo [start_web] HOST=%RADAR_HOST% PORT=%PORT%
cd /d "%WEB_DIR%"

rem --- A) free the port: kill any stale / wedged listener ---
rem NOTE: no parentheses inside this block -- an unescaped ")" closes a
rem FOR block early in cmd.exe, which silently skipped the taskkill.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo [start_web] killing stale listener on port %PORT% pid %%P
  taskkill /PID %%P /F >nul 2>&1
)
rem give the OS a moment to release the socket
ping -n 3 127.0.0.1 >nul

rem Start minimized so the task does not steal focus.
rem NOTE: do NOT redirect stdout here. "start ... >> file" attaches the
rem redirection to start itself, not to the child process -- the log file
rem stayed 0 bytes. The server appends its own stdout/stderr to
rem data\server.log (see src/server.js teeConsole), so the crash trail
rem does not depend on how the process was launched.
start "" /min node src\server.js

rem --- B) real health check ---
rem "timeout" fails when stdin is redirected; ping works everywhere.
node scripts\healthcheck.cjs --wait 40
if errorlevel 1 (
  echo [start_web] FAIL: server did not answer /api/ping within 40s
  exit /c 1
)

echo [start_web] OK: dashboard is answering on %RADAR_HOST%:%PORT%
exit /c 0
endlocal
