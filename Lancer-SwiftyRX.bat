@echo off
setlocal
chcp 65001 >nul
title SwiftyRX - agent de marche
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  Lanceur Windows. Double-clic depuis l'Explorateur.
REM
REM  Chaque etape annonce ce qu'elle fait AVANT de le faire, et la fenetre reste
REM  ouverte a la fin : une fenetre qui se ferme toute seule sur une erreur
REM  n'apprend rien a personne.
REM
REM  Les accents sont volontairement absents de ce fichier. Un .bat est lu par
REM  cmd.exe avec la page de codes du systeme, et un accent mal decode casse la
REM  commande entiere, pas seulement son affichage.
REM ---------------------------------------------------------------------------

echo.
echo ===============================================
echo   SwiftyRX - demarrage
echo ===============================================
echo.

REM --- 1. Node.js -------------------------------------------------------------
REM Node 20.12 minimum : le chargement du fichier .env passe par
REM process.loadEnvFile, apparu dans cette version (src/config/load-env.ts).
echo [1/6] Verification de Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js n'est pas installe.
  echo.
  echo   Telecharge la version LTS ici, installe-la, puis relance ce fichier :
  echo   https://nodejs.org/fr/download
  echo.
  goto :fin
)

for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set MAJOR=%%a
  set MINOR=%%b
)
if %MAJOR% LSS 20 goto :node_trop_vieux
if %MAJOR% EQU 20 if %MINOR% LSS 12 goto :node_trop_vieux
node -v
goto :git

:node_trop_vieux
echo.
echo   Ta version de Node.js est trop ancienne :
node -v
echo   Il faut au minimum la 20.12.
echo   Mets-la a jour ici, puis relance ce fichier :
echo   https://nodejs.org/fr/download
echo.
goto :fin

REM --- 2. Git -----------------------------------------------------------------
:git
echo.
echo [2/6] Recuperation de la derniere version...
where git >nul 2>&1
if errorlevel 1 (
  echo   Git n'est pas installe - on continue avec la version deja sur le disque.
  echo   Pour les mises a jour automatiques : https://git-scm.com/download/win
) else (
  git pull --ff-only
  REM Pas d'echec ici : sans reseau, la version locale fait tres bien l'affaire.
  if errorlevel 1 echo   Mise a jour impossible - on continue avec la version locale.
)

REM --- 3. Dependances ---------------------------------------------------------
echo.
echo [3/6] Verification des dependances (rapide si rien n'a change)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   L'installation a echoue. Le message ci-dessus dit pourquoi.
  echo.
  goto :fin
)

REM --- 4. Configuration -------------------------------------------------------
echo.
echo [4/6] Verification de la configuration...
if not exist ".env" (
  echo.
  echo   Premier demarrage : je cree ton fichier de configuration .env
  copy ".env.example" ".env" >nul
  echo   C'est fait. Il s'ouvre dans le Bloc-notes.
  echo.
  echo   Remplis au minimum ces lignes, puis enregistre et relance ce fichier :
  echo.
  echo     ANTHROPIC_API_KEY=      la cle qui fait analyser les nouvelles
  echo     LLM_PROVIDER=anthropic  pour activer cette analyse
  echo     CONTACT_EMAIL=          ton email, exige par le regulateur americain
  echo.
  echo   Sans ces lignes le bot lit les nouvelles mais n'analyse rien.
  echo.
  notepad ".env"
  goto :fin
)

REM --- 5. Diagnostic ----------------------------------------------------------
echo.
echo [5/6] Diagnostic...
call npm run doctor
if errorlevel 1 (
  echo.
  echo   Le bot ne peut pas demarrer - la raison est ecrite juste au-dessus.
  echo.
  REM Deux sorties possibles, et la premiere version de ce message n'en
  REM decrivait qu'une : le doctor liste des lignes BLOCKING quand il a pu
  REM tourner, mais une valeur invalide dans le .env le stoppe AVANT, et
  REM affiche alors "Configuration rejected" sans aucune ligne BLOCKING.
  echo   Dans les deux cas la cause est presque toujours une ligne du .env.
  echo   Je l'ouvre : corrige la valeur citee ci-dessus, enregistre,
  echo   puis relance ce fichier.
  echo.
  notepad ".env"
  goto :fin
)

REM --- 6. Lancement -----------------------------------------------------------
echo.
echo [6/6] Demarrage du bot et du tableau de bord...
echo.
echo   Tableau de bord : http://127.0.0.1:3000
echo   Le navigateur s'ouvre dans quelques secondes.
echo.
echo   Pour arreter : ferme cette fenetre, ou double-clique Arreter-SwiftyRX.bat
echo.
echo   Le bot ne trouve rien, ou ne prend jamais de position ?
echo   Ferme cette fenetre et double-clique Reglages-SwiftyRX.bat : il dit
echo   quels reglages changer et pourquoi, et ne modifie rien sans te demander.
echo.

REM Le navigateur part en parallele : npm run paper ne rend jamais la main, et
REM le serveur met une seconde ou deux a repondre.
start "" cmd /c "timeout /t 6 /nobreak >nul && start http://127.0.0.1:3000"

call npm run paper

:fin
echo.
echo Appuie sur une touche pour fermer cette fenetre.
pause >nul
endlocal
