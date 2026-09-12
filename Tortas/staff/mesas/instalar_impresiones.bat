@echo off
setlocal
title Instalar Impresiones Dona Susy

REM ---------------------------------------------------------------------
REM Instala el worker de impresion en una carpeta FIJA (fuera de Descargas)
REM y crea un acceso directo en el escritorio.
REM
REM Por que: Windows limpia la carpeta Descargas cada cierto tiempo
REM (Sensor de almacenamiento) y por eso el programa "desaparecia solo".
REM Ademas, al volver a descargarlo el navegador crea copias "(1)", "(2)"...
REM
REM Uso: descarga este .bat junto con impresiones_poller.py en la misma
REM carpeta y haz doble clic en el .bat UNA sola vez.
REM ---------------------------------------------------------------------

set "ORIGEN=%~dp0impresiones_poller.py"
set "DESTINO=%LOCALAPPDATA%\ImpresionesDonaSusy"
set "LANZADOR=%DESTINO%\iniciar_impresiones.bat"
set "ESCRITORIO=%USERPROFILE%\Desktop"
set "INICIO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo.
echo === Instalador de Impresiones Dona Susy ===
echo.

if not exist "%ORIGEN%" (
    echo [ERROR] No se encontro impresiones_poller.py junto a este instalador.
    echo         Descarga ambos archivos en la misma carpeta y vuelve a intentar.
    echo.
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] No se encontro Python. Instalalo desde python.org o Microsoft Store
    echo         y marca la opcion "Add python to PATH".
    echo.
    pause
    exit /b 1
)

if not exist "%DESTINO%" mkdir "%DESTINO%"
copy /Y "%ORIGEN%" "%DESTINO%\impresiones_poller.py" >nul
if errorlevel 1 (
    echo [ERROR] No se pudo copiar el programa a "%DESTINO%".
    pause
    exit /b 1
)
echo [OK] Programa copiado a: %DESTINO%

REM Lanzador: mantiene la ventana abierta si hay error para poder leerlo.
(
    echo @echo off
    echo title Impresiones Dona Susy
    echo cd /d "%%~dp0"
    echo python "%%~dp0impresiones_poller.py"
    echo if errorlevel 1 pause
) > "%LANZADOR%"
echo [OK] Lanzador creado: %LANZADOR%

REM Acceso directo en el escritorio (PowerShell crea el .lnk).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%ESCRITORIO%\Impresiones Dona Susy.lnk');" ^
  "$s.TargetPath = '%LANZADOR%';" ^
  "$s.WorkingDirectory = '%DESTINO%';" ^
  "$s.IconLocation = 'shell32.dll,16';" ^
  "$s.Save()"
if errorlevel 1 (
    echo [AVISO] No se pudo crear el acceso directo en el escritorio.
) else (
    echo [OK] Acceso directo creado en el escritorio: "Impresiones Dona Susy"
)

echo.
choice /C SN /M "Quieres que se abra solo al encender la computadora? (S/N)"
if errorlevel 2 goto :sin_inicio
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%INICIO%\Impresiones Dona Susy.lnk');" ^
  "$s.TargetPath = '%LANZADOR%';" ^
  "$s.WorkingDirectory = '%DESTINO%';" ^
  "$s.Save()"
if errorlevel 1 (
    echo [AVISO] No se pudo agregar al inicio de Windows.
) else (
    echo [OK] Se abrira solo al iniciar sesion en Windows.
)
:sin_inicio

REM Limpiar copias sueltas en Descargas (impresiones_poller.py, "(1)", "(2)"...).
set "DESCARGAS=%USERPROFILE%\Downloads"
dir /b "%DESCARGAS%\impresiones_poller*.py" >nul 2>nul
if errorlevel 1 goto :fin
echo.
echo Se encontraron copias del programa en Descargas:
dir /b "%DESCARGAS%\impresiones_poller*.py"
echo.
choice /C SN /M "Borrar esas copias de Descargas para que solo quede la instalada? (S/N)"
if errorlevel 2 goto :fin
del /Q "%DESCARGAS%\impresiones_poller*.py"
echo [OK] Copias de Descargas eliminadas.

:fin
echo.
echo Listo. Usa el acceso directo "Impresiones Dona Susy" del escritorio.
echo Si lo abres dos veces, la segunda copia avisa y se cierra sola.
echo.
pause
endlocal
