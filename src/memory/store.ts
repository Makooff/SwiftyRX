/**
 * Où la mémoire est écrite, et sous quelle forme.
 *
 * Deux formats pour deux lecteurs, une seule source de vérité :
 *
 *  - `memoire/lecons.jsonl` et `memoire/regles.json` sont ce que le code lit
 *    et écrit. JSON, donc pas d'analyse syntaxique fragile.
 *  - `memoire/regles.md` et `memoire/setups.md` sont **régénérés** à partir des
 *    précédents. C'est ce que tu lis, et ce que Claude relit avant chaque
 *    analyse.
 *
 * Le markdown n'est jamais lu par le code, seulement écrit. Deux sources de
 * vérité qui divergent silencieusement seraient pires que pas de mémoire du
 * tout, parce qu'on ne saurait plus laquelle a raison.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LIBELLE_SETUP } from '../risk/types.js';
import { libelleConfiance } from '../settings.js';
import type { Bilan } from '../journal/stats.js';
import type { Lecon, Memoire, Regle } from './types.js';

export const CHEMIN_LECONS = 'memoire/lecons.jsonl';
export const CHEMIN_REGLES = 'memoire/regles.json';
export const CHEMIN_REGLES_MD = 'memoire/regles.md';
export const CHEMIN_SETUPS_MD = 'memoire/setups.md';

async function lireJson<T>(chemin: string, defaut: T): Promise<T> {
  try {
    return JSON.parse(await readFile(chemin, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaut;
    throw err;
  }
}

async function ecrire(chemin: string, contenu: string): Promise<void> {
  await mkdir(dirname(chemin), { recursive: true });
  await writeFile(chemin, contenu, 'utf8');
}

export async function chargerMemoire(racine = ''): Promise<Memoire> {
  const cheminLecons = racine ? `${racine}/${CHEMIN_LECONS}` : CHEMIN_LECONS;
  const cheminRegles = racine ? `${racine}/${CHEMIN_REGLES}` : CHEMIN_REGLES;

  let lecons: Lecon[] = [];
  try {
    const brut = await readFile(cheminLecons, 'utf8');
    lecons = brut
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Lecon];
        } catch {
          return [];
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const regles = await lireJson<Regle[]>(cheminRegles, []);
  return { lecons, regles };
}

/** Ajoute une leçon. Ajout seul, comme le journal, et pour la même raison. */
export async function ajouterLecon(lecon: Omit<Lecon, 'id'>, racine = ''): Promise<Lecon> {
  const chemin = racine ? `${racine}/${CHEMIN_LECONS}` : CHEMIN_LECONS;
  const memoire = await chargerMemoire(racine);
  const complete: Lecon = { ...lecon, id: `L-${String(memoire.lecons.length + 1).padStart(3, '0')}` };
  await mkdir(dirname(chemin), { recursive: true });
  await appendFile(chemin, `${JSON.stringify(complete)}\n`, 'utf8');
  return complete;
}

export async function ecrireRegles(regles: Regle[], racine = ''): Promise<void> {
  const chemin = racine ? `${racine}/${CHEMIN_REGLES}` : CHEMIN_REGLES;
  await ecrire(chemin, `${JSON.stringify(regles, null, 2)}\n`);
}

/**
 * Ce qu'une leçon doit avoir pour être acceptée.
 *
 * Le filtre est volontairement grossier — il n'y a pas de façon fiable de
 * juger une phrase par programme. Il attrape le cas le plus fréquent : la
 * généralité qui s'applique partout et ne se teste nulle part. « Il faut être
 * plus patient » passe ce test aucune fois ; « un retest en session asiatique
 * sur les majeures n'a pas le volume pour tenir » le passe.
 */
const BANALITES = [
  'patient', 'discipline', 'psycholog', 'émotion', 'emotion', 'confiance en moi',
  'respecter le plan', 'ne pas surtrader', 'rester calme', 'faire mieux',
];

export function leconRecevable(texte: string): { ok: boolean; motif?: string } {
  const nettoye = texte.trim().toLowerCase();
  if (nettoye.length < 25) {
    return { ok: false, motif: 'trop courte pour être une leçon testable' };
  }
  if (nettoye.split(/\s+/).length > 45) {
    return { ok: false, motif: 'trop longue : une leçon tient en une phrase' };
  }
  const banalite = BANALITES.find((b) => nettoye.includes(b));
  if (banalite && !/\b(si|quand|sur|après|avant|entre|sous|au-dessus)\b/.test(nettoye)) {
    return {
      ok: false,
      motif: `généralité non testable autour de « ${banalite} » — une leçon doit nommer une condition observable`,
    };
  }
  return { ok: true };
}

/** Rend `regles.md`, la version que tu lis. */
export function rendreReglesMd(memoire: Memoire): string {
  const actives = memoire.regles.filter((r) => r.statut === 'active');
  const retrogradees = memoire.regles.filter((r) => r.statut === 'retrogradee');

  const lignes: string[] = [
    '# Règles apprises',
    '',
    '> Fichier généré par `npm run bilan`. Ne pas éditer à la main : la source est `regles.json`.',
    '',
    'Une règle ne peut que **refuser** un trade ou **réduire** sa taille.',
    "Aucune ne peut en autoriser un que les bornes refusent, ni augmenter une position.",
    '',
    `**${actives.length} règles actives.**`,
    '',
  ];

  if (actives.length === 0) {
    lignes.push(
      "Aucune règle pour l'instant. Il en faut trois leçons concordantes pour en produire une,",
      'et rien ne sera promu avant.',
      '',
    );
  }

  for (const r of actives) {
    const d = r.declencheur;
    const conditions = [
      d.setup ? `setup = ${d.setup}` : null,
      `étiquette = ${d.etiquette}`,
      d.symbole ? `paire = ${d.symbole}` : null,
      d.classe ? `classe = ${d.classe}` : null,
      d.heuresUtc ? `heure UTC entre ${d.heuresUtc[0]} h et ${d.heuresUtc[1]} h` : null,
    ].filter(Boolean);

    lignes.push(
      `### ${r.id} — ${r.enonce}`,
      '',
      `- Déclencheur : ${conditions.join(' et ')}`,
      `- Action : ${r.action === 'refuser' ? 'refuser le trade' : 'réduire la taille de moitié'}`,
      `- Preuves : ${libelleConfiance(r.preuves.n)}, espérance ${r.preuves.esperanceR} R — leçons ${r.preuves.lecons.join(', ')}`,
      `- Promue le : ${r.promueLe.slice(0, 10)}`,
      `- Observations depuis : ${r.suivi.length}`,
      '',
    );
  }

  if (retrogradees.length > 0) {
    lignes.push('## Règles retirées', '');
    for (const r of retrogradees) {
      lignes.push(
        `- **${r.id}** — ${r.enonce}`,
        `  Retirée le ${r.retrogradeeLe?.slice(0, 10)} : ${r.motifRetrogradation}`,
        '',
      );
    }
  }

  return `${lignes.join('\n')}\n`;
}

/** Rend `setups.md`, le tableau des statistiques par setup. */
export function rendreSetupsMd(b: Bilan): string {
  const lignes: string[] = [
    '# Statistiques par setup',
    '',
    '> Fichier généré par `npm run bilan`.',
    '',
  ];

  if (b.trades === 0) {
    lignes.push(
      "Aucun trade dénoué. Rien à mesurer, et rien ne sera affirmé avant qu'il y ait de quoi.",
      '',
    );
    return `${lignes.join('\n')}\n`;
  }

  lignes.push(
    `${b.trades} trades dénoués, ${b.attentes} attentes, ${b.refusMoteur} refus du moteur.`,
    `Espérance globale ${b.esperanceR} R, ${b.esperanceNetteR} R une fois les frais payés.`,
    `Pire série de pertes : ${b.pireSerie}.`,
    '',
    '| Setup | n | Réussite | Espérance | Nette | Confiance |',
    '|---|---|---|---|---|---|',
  );

  for (const s of [...b.parSetup].sort((a, x) => x.esperanceR - a.esperanceR)) {
    lignes.push(
      `| ${LIBELLE_SETUP[s.setup]} | ${s.n} | ${s.tauxReussitePct} % | ${s.esperanceR} R | ${s.esperanceNetteR} R | ${s.confiance} |`,
    );
  }

  lignes.push('');

  const suspects = b.parSetup.filter((s) => s.gainsParChance > 0 || s.stopsTropServes > 0);
  if (suspects.length > 0) {
    lignes.push('## À regarder', '');
    for (const s of suspects) {
      if (s.gainsParChance > 0) {
        lignes.push(
          `- **${LIBELLE_SETUP[s.setup]}** : ${s.gainsParChance} gains issus d'un mauvais processus. Le résultat flatte la méthode.`,
        );
      }
      if (s.stopsTropServes > 0) {
        lignes.push(
          `- **${LIBELLE_SETUP[s.setup]}** : ${s.stopsTropServes} stops touchés avant que le prix reparte dans le bon sens. C'est le placement du stop, pas l'analyse.`,
        );
      }
    }
    lignes.push('');
  }

  return `${lignes.join('\n')}\n`;
}

export async function ecrireVues(memoire: Memoire, b: Bilan, racine = ''): Promise<void> {
  const p = (c: string) => (racine ? `${racine}/${c}` : c);
  await ecrire(p(CHEMIN_REGLES_MD), rendreReglesMd(memoire));
  await ecrire(p(CHEMIN_SETUPS_MD), rendreSetupsMd(b));
}
