@echo off
rem ---------------------------------------------------------------------------
rem  Double-click entry: make sure the gateway is running, then open the web UI.
rem
rem  ASCII ONLY. Never put non-ASCII text in this file -- see the note below.
rem  All real logic lives in the .ps1 next to this file (same base name).
rem
rem  Why this file is ASCII-only and logic-free:
rem    cmd.exe parses .bat by byte offset. On a file that mixes multi-byte text
rem    with "chcp 65001", those offsets drift: @echo off stops taking effect and
rem    the tail of a Chinese line gets executed as a command
rem    ("'unchd' is not recognized"), so the window flashes and closes.
rem    Adding a BOM or splitting the line does not fix it. Keep this file pure
rem    ASCII and let PowerShell (which reads UTF-8 correctly) do the work.
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

rem Prefer the packaged powershell.exe even when PATH is minimal (processes
rem launched by explorer.exe do not always inherit the full user PATH).
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSEXE%" set "PSEXE=powershell.exe"

rem Derive the script path from this file's own name so renaming the pair stays
rem in sync. %~n0 is this file's name without extension.
set "PS1=%~dp0%~n0.ps1"
if not exist "%PS1%" (
  echo [open-console] missing script: "%PS1%"
  pause
  exit /b 1
)

rem -NoProfile: a user profile that prints output or changes directory breaks it.
rem -ExecutionPolicy Bypass: double-click must not die on the default Restricted.
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

rem Non-zero means something failed and the user needs to read the output.
if not "%RC%"=="0" (
  echo.
  echo [open-console] failed with exit code %RC%.
  pause
)
exit /b %RC%
