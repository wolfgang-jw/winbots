@echo off
title Bots - One-Click Zip Packaging
echo.
echo  ============================================================
echo    Bots AI - One-Click ZIP Packaging (Portable)
echo  ============================================================
echo.
echo   [Info] This script will:
echo          1. Build the Bots-Portable green folder
echo          2. Compress it into BotsAI-Portable.zip
echo.
echo   [Info] Target machine needs NO extra software installed.
echo          Delete the folder to fully uninstall.
echo.
cd /d "%~dp0"

REM ---------- Step 0: Check runtime ----------
echo.
echo  [0/4] Checking .bun\bun.exe runtime...
if not exist ".bun\bun.exe" (
    echo   [ERROR] .bun\bun.exe not found! Please confirm the project is complete.
    pause
    exit /b 1
)

REM ---------- Step 1: Build Bots-Portable ----------
set "OUTPUT_DIR=%~dp0Bots-Portable"
echo.
echo  [1/4] Building Bots-Portable folder...

REM Clean old directory
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

REM Remove old zip BEFORE building to avoid stale artifacts
if exist "BotsAI-Portable.zip" del /q "BotsAI-Portable.zip"

REM ---------- Copy folders (per .gitignore, with exceptions) ----------
echo   - Copying folders ...

REM Copy .bun (EXCEPTION: kept from .gitignore, portable runtime)
echo     .bun ...
xcopy /e /i /q /h /y ".bun" "%OUTPUT_DIR%\.bun" >nul

REM Copy node_modules (EXCEPTION: kept from .gitignore, dependencies)
echo     node_modules ...
xcopy /e /i /q /h /y "node_modules" "%OUTPUT_DIR%\node_modules" >nul

REM Copy src (source code)
echo     src ...
xcopy /e /i /q /h /y "src" "%OUTPUT_DIR%\src" >nul

REM Copy public (frontend assets)
echo     public ...
xcopy /e /i /q /h /y "public" "%OUTPUT_DIR%\public" >nul

REM NOTE: .vscode, docs, .git are NOT copied (ignored / not for distribution)

REM ---------- Copy files ----------
echo   - Copying files ...

REM Copy .env.example (renamed to .env later in the intermediate folder)
echo     .env.example ...
copy /y ".env.example" "%OUTPUT_DIR%\.env.example" >nul

REM Copy config files
echo     package.json ...
copy /y "package.json" "%OUTPUT_DIR%\package.json" >nul
echo     bun.lock ...
copy /y "bun.lock" "%OUTPUT_DIR%\bun.lock" >nul
echo     tsconfig.json ...
copy /y "tsconfig.json" "%OUTPUT_DIR%\tsconfig.json" >nul
echo     README.md ...
copy /y "README.md" "%OUTPUT_DIR%\README.md" >nul

REM Copy start.bat (preserved from project root)
echo     start.bat ...
copy /y "start.bat" "%OUTPUT_DIR%\start.bat" >nul

REM NOTE: .env, .gitignore, packageZip.bat are NOT copied (ignored / script itself)

REM ---------- Handle .env in intermediate folder ----------
echo   - Setting up .env in intermediate folder ...
REM Delete .env if present (should not be copied, safety)
if exist "%OUTPUT_DIR%\.env" del /q "%OUTPUT_DIR%\.env"
REM Rename .env.example to .env
if exist "%OUTPUT_DIR%\.env.example" (
    ren "%OUTPUT_DIR%\.env.example" ".env"
)

echo   [OK] Bots-Portable folder built.

REM ---------- Step 2: Compress to zip ----------
echo.
echo  [2/4] Removing old zip file (double check)...
if exist "BotsAI-Portable.zip" del /q "BotsAI-Portable.zip"

echo.
echo  [3/4] Compressing to BotsAI-Portable.zip ...
echo   [INFO] This may take a few minutes. Please wait...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%OUTPUT_DIR%' -DestinationPath '%~dp0BotsAI-Portable.zip' -CompressionLevel Optimal -Force"

if errorlevel 1 (
    echo.
    echo   [ERROR] Compression failed! Check disk space or permissions.
    pause
    exit /b 1
)

REM ---------- Cleanup intermediate folder ----------
echo.
echo  [4/4] Cleaning up intermediate folder...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
echo   [OK] Removed Bots-Portable folder.

REM ---------- Done ----------
echo.
echo  ============================================================
echo    Packaging SUCCESS!
echo  ============================================================
echo    Generated: %~dp0BotsAI-Portable.zip
echo.
echo    Deployment:
echo    1. Copy BotsAI-Portable.zip to target Windows machine
echo    2. Extract to any location (e.g. D:\BotsAI)
echo    3. Double-click start.bat to start the server
echo    4. Open browser at http://localhost:3001
echo.
echo    Uninstall:
echo    Delete the extracted folder. No system residue remains.
echo  ============================================================
echo.
echo   [Note] The intermediate Bots-Portable folder has been removed automatically.
echo.
pause
