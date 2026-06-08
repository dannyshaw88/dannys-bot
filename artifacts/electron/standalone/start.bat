@echo off
setlocal

set "HERE=%~dp0"
set "FRONTEND_DIST_PATH=%HERE%public"
set "PORT=8080"
set "HOST=127.0.0.1"

echo.
echo  Equinox Dev Server
echo  ------------------
echo  Open http://localhost:8080 in your browser
echo  Close this window to stop the server.
echo.

node "%HERE%server\index.mjs"

pause
