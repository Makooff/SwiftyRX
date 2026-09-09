@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Copilote de trading

if not exist node_modules (
  echo Premiere installation, patiente une minute...
  call npm install || goto :erreur
)

if not exist .env (
  echo.
  echo   Aucun fichier .env. Copie .env.exemple en .env et mets ta cle dedans.
  echo.
)

start "" http://localhost:4830
call npm start
goto :fin

:erreur
echo.
echo   L'installation a echoue. Verifie que Node.js 20 ou plus est installe.
echo.
pause

:fin
pause
