@echo off
rem Abre el visor. Podés arrastrar cualquier carpeta encima de este archivo para verla.
cd /d "%~dp0"
set "PACK=%~1"
if "%PACK%"=="" set "PACK=C:\Users\diego\Downloads\ULTR4_P4CK_SK1NS_mu"
node server.js "%PACK%"
pause
