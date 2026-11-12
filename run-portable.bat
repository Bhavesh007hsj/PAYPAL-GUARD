@echo off
title PayGuard AI Portable Launcher
echo ==================================================================
echo         Starting PayGuard AI Standalone Desktop Application
echo ==================================================================
echo.
cd /d "%~dp0"
if exist "dist-exe\payguard-ai.exe" (
    dist-exe\payguard-ai.exe
) else if exist "payguard-ai.exe" (
    payguard-ai.exe
) else (
    echo [PayGuard AI] Executable not found. Compiling now...
    call npm run build:exe
    dist-exe\payguard-ai.exe
)
pause
