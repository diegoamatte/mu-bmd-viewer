@echo off
rem Abre el visor con la ultima carpeta usada. La carpeta se cambia desde el visor
rem (boton "Elegir carpeta"), o arrastrando una carpeta encima de este archivo.
cd /d "%~dp0"
node server.js "%~1"
pause
