@echo off
title Bots AI Server
echo.
echo  ============================================================
echo    Bots AI Server - Portable Edition
echo  ============================================================
echo.
echo   [Hint] Press Ctrl+C to stop the server
echo.

cd /d "%~dp0"

REM Check bun.exe exists
if not exist ".bun\bun.exe" (
    echo  [ERROR] .bun\bun.exe not found. Please check the project.
    echo.
    pause
    exit /b 1
)

echo  Starting server...
echo.

".bun\bun.exe" src\index.ts

echo.
echo  ============================================================
echo    Server stopped.
echo  ============================================================
echo.
pause
