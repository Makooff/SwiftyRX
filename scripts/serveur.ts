/**
 * `npm start` — lance l'application.
 *
 * Charge `.env` s'il existe, démarre le serveur local, affiche l'adresse.
 * Rien à installer d'autre, rien à configurer à part la clé API.
 */

import { readFile } from 'node:fs/promises';
import { demarrer } from '../src/server/server.js';

/**
 * Un lecteur de `.env` minimal.
 *
 * Une dépendance de plus pour lire des lignes `CLE=valeur` ne se justifie pas,
 * et celle-ci ne fait rien d'autre : pas d'interpolation, pas de valeurs
 * multilignes. Les variables déjà présentes dans l'environnement gagnent.
 */
async function chargerEnv(): Promise<void> {
  let brut: string;
  try {
    brut = await readFile('.env', 'utf8');
  } catch {
    return;
  }
  for (const ligne of brut.split('\n')) {
    const nette = ligne.trim();
    if (!nette || nette.startsWith('#')) continue;
    const separateur = nette.indexOf('=');
    if (separateur <= 0) continue;
    const cle = nette.slice(0, separateur).trim();
    if (process.env[cle] !== undefined) continue;
    process.env[cle] = nette
      .slice(separateur + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
}

await chargerEnv();

const adresse = await demarrer();

const l = ['', `  Copilote de trading  ·  ${adresse}`, ''];
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  l.push(
    "  ⚠ Aucune clé API. L'écran s'affichera, mais l'analyse échouera.",
    '    Copie .env.exemple en .env et mets ta clé dedans, puis relance.',
    '',
  );
}
l.push('  Ctrl+C pour arrêter.', '');
process.stdout.write(`${l.join('\n')}\n`);
