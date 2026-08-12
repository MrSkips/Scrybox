@echo off
REM Debug launcher — shows a console window so you can see errors
REM (e.g. if Python or Firefox isn't found). Use "Start Scrybox.vbs"
REM for normal day-to-day use once this confirms everything works.

cd /d "%~dp0"
echo Starting Scrybox server on http://localhost:8000 ...
start "Scrybox Server" cmd /k python -m http.server 8000
timeout /t 2 >nul
start firefox http://localhost:8000
echo.
echo If Firefox didn't open, or you see errors above, make sure both
echo Python and Firefox are installed and available on your system.
pause
