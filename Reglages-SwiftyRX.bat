@echo off
setlocal
chcp 65001 >nul
title SwiftyRX - reglages
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  Reglages. Double-clic depuis l'Explorateur.
REM
REM  Affiche ce que le bot recommande et pourquoi, puis demande avant d'ecrire
REM  quoi que ce soit. Rien ne s'applique tout seul : un reglage qui change sans
REM  qu'on le sache est exactement ce que ce projet refuse.
REM
REM  Ce fichier existe parce que la seule autre facon de lancer "npm run tune"
REM  est d'ouvrir un terminal, ce qui n'est pas une chose a demander a quelqu'un
REM  pour consulter ses propres reglages.
REM
REM  Accents volontairement absents : cmd.exe les decode avec la page de codes
REM  du systeme, et un accent mal lu casse la commande, pas seulement l'affichage.
REM ---------------------------------------------------------------------------

echo.
echo ===============================================
echo   SwiftyRX - reglages recommandes
echo ===============================================

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js n'est pas installe. Lance d'abord Lancer-SwiftyRX.bat,
  echo   il t'expliquera quoi installer.
  echo.
  goto :fin
)

if not exist ".env" (
  echo.
  echo   Pas encore de configuration. Lance d'abord Lancer-SwiftyRX.bat :
  echo   il cree le fichier .env au premier demarrage.
  echo.
  goto :fin
)

echo.
call npm run tune
if errorlevel 1 goto :fin

echo.
echo ===============================================
set /p REPONSE=Appliquer ces reglages ? (O/N) :
if /i not "%REPONSE%"=="O" (
  echo.
  echo   Rien n'a ete modifie.
  goto :fin
)

echo.
call npm run tune -- --apply

:fin
echo.
echo Appuie sur une touche pour fermer cette fenetre.
pause >nul
endlocal
