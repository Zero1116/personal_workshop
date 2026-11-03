@echo off
rem ---------------------------------------------------------------------------
rem  open-console.bat  --  ASCII ONLY. Do not put Chinese text in this file.
rem
rem  Double-click entry: make sure the gateway is running, then open the web UI.
rem  All real logic lives in open-console.ps1 next to this file.
rem
rem  Why this file is ASCII-only and logic-free:
rem    cmd.exe parses .bat by byte offset. On a file that mixes a UTF-8 BOM,
rem    "chcp 65001" and multi-byte text, the offsets drift: @echo off stops
rem    working and the tail of a Chinese line gets executed as a command
rem    ("'unchd' is not recognized"). Splitting the line would only stop that
rem    one error. So: no non-ASCII bytes here at all, and PowerShell (which
rem    reads UTF-8 correctly) does the work.
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

rem Prefer the packaged powershell.exe even when PATH is minimal (explorer.exe
rem launched processes do not always inherit the full user PATH).
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSEXE%" set "PSEXE=powershell.exe"

rem -NoProfile: a user profile that prints output or changes the location would
rem break the script. -ExecutionPolicy Bypass: double-click must not die on the
rem default Restricted policy.
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-console.ps1"
set "RC=%ERRORLEVEL%"

rem Non-zero means something failed and the user needs to read the output.
if not "%RC%"=="0" (
  echo.
  echo [open-console] failed with exit code %RC%.
  pause
)
exit /b %RC%
