@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting MOSS-Image Studio at http://127.0.0.1:7860 ...
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:7860"
python moss_studio\server.py
if errorlevel 1 (
    echo.
    echo [Error] MOSS-Image Studio exited with an error.
    pause
)
