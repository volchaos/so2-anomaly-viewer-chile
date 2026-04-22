@echo off
chcp 65001 >nul
setlocal

set REPO=C:\Users\nhida\OneDrive\Documentos\GitHub\so2-anomaly-viewer-chile
set DOWNLOADS=%USERPROFILE%\Downloads

echo.
echo  SO2 Viewer - Deploy automatico
echo  ================================

if not exist "%REPO%" (
    echo [ERROR] No se encontro el repo en: %REPO%
    pause
    exit /b 1
)

set COPIED=0

if exist "%DOWNLOADS%\styles.css" (
    copy /Y "%DOWNLOADS%\styles.css" "%REPO%\styles.css" >nul
    echo [OK] styles.css copiado
    set COPIED=1
)

if exist "%DOWNLOADS%\index.html" (
    copy /Y "%DOWNLOADS%\index.html" "%REPO%\index.html" >nul
    echo [OK] index.html copiado
    set COPIED=1
)

if exist "%DOWNLOADS%\app.js" (
    copy /Y "%DOWNLOADS%\app.js" "%REPO%\src\app.js" >nul
    echo [OK] app.js copiado a src/
    set COPIED=1
)

if exist "%DOWNLOADS%\config.js" (
    copy /Y "%DOWNLOADS%\config.js" "%REPO%\src\config.js" >nul
    echo [OK] config.js copiado a src/
    set COPIED=1
)

if exist "%DOWNLOADS%\build_gif.py" (
    copy /Y "%DOWNLOADS%\build_gif.py" "%REPO%\scripts\build_gif.py" >nul
    echo [OK] build_gif.py copiado a scripts/
    set COPIED=1
)

if %COPIED%==0 (
    echo [AVISO] No se encontro ningun archivo en Descargas.
    pause
    exit /b 1
)

echo.
echo  Subiendo cambios a GitHub...
echo  --------------------------------

cd /d "%REPO%"
git add .

for /f "tokens=1-3 delims=/ " %%a in ("%date%") do set HOY=%%c-%%b-%%a
for /f "tokens=1-2 delims=: " %%a in ("%time%") do set HORA=%%a:%%b
git commit -m "Actualizacion %HOY% %HORA%"

git push origin main

if %ERRORLEVEL%==0 (
    echo.
    echo  Listo! Cambios publicados en GitHub Pages.
) else (
    echo.
    echo [ERROR] Algo fallo al hacer push.
)

echo.
pause