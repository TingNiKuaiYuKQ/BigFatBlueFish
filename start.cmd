@echo off
setlocal

rem ---------------------------------------------------------------------------
rem BigFatBlueFish 0.6.0 - console launcher (troubleshooting) and installer.
rem
rem   start.cmd            start the pet, keeping this console for logs
rem   start.cmd install    (re)install launcher.lnk + desktop/start-menu shortcuts
rem
rem Why everything goes through main\launch.mjs:
rem   1. A proxy is often set in both HTTP_PROXY and http_proxy. Node rebuilds
rem      the whole environment block, so launch.mjs removes duplicate keys.
rem   2. Chromium's sandbox cannot start here: --no-sandbox is required.
rem   3. --user-data-dir must be explicit; otherwise Chromium crashes while
rem      resolving the default profile (exit 0xffff7003).
rem   4. endpoint.json must be mirrored to ~/.dsh/live2d by a node.exe process;
rem      electron.exe is blocked there by system policy (EPERM).
rem
rem ASCII only: cmd.exe parses batch files with the ANSI code page.
rem ---------------------------------------------------------------------------

set "ELECTRON_RUN_AS_NODE="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "ALL_PROXY="
set "all_proxy="
set "NO_PROXY="
set "no_proxy="

cd /d "%~dp0"

if /I "%~1"=="install" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js not found. Install Node.js 22+ first.
    pause
    exit /b 1
  )
  node "main\scripts\shortcut.mjs" install
  exit /b 0
)

if not exist "main\deps\node_modules\electron\dist\electron.exe" (
  echo Dependencies missing. Run: npm --prefix main\deps install
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 goto standalone

rem Normal path: the node launcher owns the handshake mirror.
node "main\launch.mjs" %*
exit /b 0

:standalone
rem No node in PATH: still runnable, but the DSH plugin cannot find the pet
rem because the handshake mirror is not written.
echo Node.js not found in PATH: starting in STANDALONE mode.
echo The DSH plugin will not find this pet.
"main\deps\node_modules\electron\dist\electron.exe" "main" --no-sandbox --force-device-scale-factor=1 --user-data-dir="main\runtime\chromium" %*
