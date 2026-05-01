@echo off
echo Installing dependencies...
npm install
if errorlevel 1 goto error

echo Building server and frontend...
npm run build
if errorlevel 1 goto error

echo Starting Danny's Bot...
node index.js
goto end

:error
echo.
echo Something went wrong. Check the error above.

:end
pause
