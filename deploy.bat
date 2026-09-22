@echo off
setlocal enabledelayedexpansion

title Placement Monitoring - Full Stack Deployment

echo =======================================================
echo     Placement Monitoring - Full Stack Deployment
echo =======================================================
echo.

:: Ensure working directory is the script's root folder
cd /d "%~dp0"

:: ---------------------------------------------------------
:: 1. Deploy Backend (Cloudflare Worker)
:: ---------------------------------------------------------
echo [1/3] Deploying Backend (Cloudflare Worker to Production)...
cd backend
call npm run worker:deploy
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Backend deployment failed with error code %ERRORLEVEL%.
    cd /d "%~dp0"
    pause
    exit /b %ERRORLEVEL%
)
cd /d "%~dp0"
echo [SUCCESS] Backend deployed successfully!
echo.

:: ---------------------------------------------------------
:: 2. Build Frontend
:: ---------------------------------------------------------
echo [2/3] Building Frontend Production Bundle...
cd frontend
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Frontend build failed with error code %ERRORLEVEL%.
    cd /d "%~dp0"
    pause
    exit /b %ERRORLEVEL%
)
echo [SUCCESS] Frontend built successfully!
echo.

:: ---------------------------------------------------------
:: 3. Deploy Frontend (Vercel)
:: ---------------------------------------------------------
echo [3/3] Deploying Frontend to Vercel...
call npx vercel --prod --yes
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [INFO] Retrying with interactive Vercel deploy...
    call npx vercel --prod
)
cd /d "%~dp0"

echo.
echo =======================================================
echo   Full Stack Deployment Finished!
echo =======================================================
echo.
pause
