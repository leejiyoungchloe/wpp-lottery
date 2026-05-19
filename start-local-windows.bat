@echo off
cd /d "%~dp0"
echo Starting WPP Media Delivery lottery...
echo.
echo If Windows Firewall asks for permission, allow Node.js on the current network.
echo The browser will open http://127.0.0.1:5173 after the server starts.
echo.
start "" "http://127.0.0.1:5173"
npm start
pause
