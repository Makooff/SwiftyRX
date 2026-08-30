@echo off
setlocal
chcp 65001 >nul
title SwiftyRX - arret
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  Arrete le bot en liberant le port du tableau de bord.
REM
REM  On vise le port plutot que "tous les node.exe" : la machine fait peut-etre
REM  tourner autre chose en Node, et tuer ces processus-la serait une surprise
REM  desagreable pour quelqu'un venu simplement arreter son bot.
REM ---------------------------------------------------------------------------

set PORT=3000
if not "%DASHBOARD_PORT%"=="" set PORT=%DASHBOARD_PORT%

echo.
echo Arret de SwiftyRX (port %PORT%)...
echo.

set TROUVE=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr ":%PORT% "') do (
  echo   Arret du processus %%p
  taskkill /PID %%p /F >nul 2>&1
  set TROUVE=1
)

if "%TROUVE%"=="0" (
  echo   Rien ne tournait sur le port %PORT% - le bot etait deja arrete.
) else (
  echo.
  echo   C'est fait. Ton portefeuille et ton historique sont sauvegardes
  echo   dans le dossier data - ils seront repris au prochain demarrage.
)

echo.
echo Appuie sur une touche pour fermer cette fenetre.
pause >nul
endlocal
