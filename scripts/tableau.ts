/**
 * `npm run tableau` — l'état du compte en une page.
 *
 * Dans le terminal, pas dans un navigateur. Un tableau de bord web supposait
 * un serveur, un port et un processus qui tourne ; il n'y a plus rien de tout
 * ça à faire tourner ici, et une commande qui affiche vingt lignes fait le
 * même travail sans rien démarrer.
 */

import { Journal } from '../src/journal/journal.js';
import { bilan } from '../src/journal/stats.js';
import { Compte, drawdownPct } from '../src/journal/state.js';
import { chargerMemoire } from '../src/memory/store.js';
import { MoteurRisque } from '../src/risk/engine.js';
import { LIBELLE_SETUP } from '../src/risk/types.js';
import { BORNES, ECHANTILLON } from '../src/settings.js';
import { rendreTableauHtml } from '../src/journal/html.js';
import { jeuDeDemonstration } from '../src/journal/demo.js';
import { lireArgs, texte } from './args.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = lireArgs();

const journal = new Journal();
const compte = new Compte();
const memoire = await chargerMemoire();

const entrees = await journal.lireTout();
const etat = await compte.charger();
const stats = bilan(entrees);
const arrets = new MoteurRisque().conditionsArret(etat);

if (args.html) {
  // Journal vide : la page montre un jeu d'exemple explicitement marqué. Une
  // coquille vide ne dirait pas à quoi sert l'écran, et un chiffre inventé
  // présenté comme réel serait pire que les deux.
  const donnees = entrees.length === 0
    ? jeuDeDemonstration()
    : { etat, bilan: stats, memoire, entrees, arrets, demonstration: false };

  const chemin = texte(args, 'sortie') ?? 'journal/tableau.html';
  const complet = args.fragment !== true;
  await mkdir(dirname(chemin), { recursive: true });
  await writeFile(chemin, rendreTableauHtml(donnees, { complet }), 'utf8');
  process.stdout.write(
    `${chemin} écrit${donnees.demonstration ? " — jeu d'exemple, le journal est vide" : ''}\n`,
  );
  process.exit(0);
}

const barre = '─'.repeat(64);
const l: string[] = ['', barre];

const variation = etat.capital - BORNES.capitalInitial;
l.push(
  `  ${etat.capital.toFixed(2)} ${etat.devise}   ${variation >= 0 ? '+' : ''}${variation.toFixed(2)} depuis le départ  ·  drawdown ${drawdownPct(etat)} %`,
  barre,
  '',
);

if (arrets.length > 0) {
  l.push('  TRADING ARRÊTÉ', '');
  for (const a of arrets) l.push(`    ${a.message}`);
  l.push('');
} else {
  const risqueEngage = etat.positions.reduce((s, p) => s + p.risqueOuvert, 0);
  l.push(
    `  ${etat.positions.length}/${BORNES.positionsMax} positions  ·  ${etat.tradesAujourdhui}/${BORNES.tradesParJourMax} trades aujourd'hui  ·  ${risqueEngage.toFixed(2)} ${etat.devise} engagés`,
    '',
  );
}

if (etat.positions.length > 0) {
  l.push('  Ouvert', '');
  for (const p of etat.positions) {
    l.push(
      `    ${p.symbole.padEnd(10)} ${p.sens.padEnd(6)} ${p.notionnel.toFixed(0).padStart(7)} ${etat.devise}  risque ${p.risqueOuvert.toFixed(2)}`,
    );
  }
  l.push('');
}

if (stats.trades === 0) {
  l.push(
    `  ${stats.decisions} décisions, aucun trade dénoué.`,
    "  Rien à mesurer pour l'instant, et rien ne sera affirmé.",
    '',
  );
} else {
  l.push(
    `  ${stats.trades} trades  ·  ${stats.gains}G / ${stats.pertes}P  ·  ${stats.tauxReussitePct} %`,
    `  espérance ${stats.esperanceR > 0 ? '+' : ''}${stats.esperanceR} R  ·  nette ${stats.esperanceNetteR > 0 ? '+' : ''}${stats.esperanceNetteR} R  ·  cumul ${stats.cumulR > 0 ? '+' : ''}${stats.cumulR} R`,
    `  pire série ${stats.pireSerie}  ·  frais ${stats.fraisTotaux} ${etat.devise}  ·  ${stats.attentes} attentes`,
    '',
  );

  if (stats.trades < ECHANTILLON.minimumPourRegler) {
    l.push(
      `  ${stats.trades} trades sur les ${ECHANTILLON.minimumPourRegler} nécessaires pour que ces chiffres décident de quoi que ce soit.`,
      '',
    );
  }

  const top = [...stats.parSetup].sort((a, b) => b.esperanceR - a.esperanceR).slice(0, 5);
  for (const s of top) {
    l.push(
      `    ${LIBELLE_SETUP[s.setup].padEnd(36)} n=${String(s.n).padStart(3)}  ${s.esperanceR > 0 ? '+' : ''}${s.esperanceR} R  ${s.confiance}`,
    );
  }
  l.push('');
}

const actives = memoire.regles.filter((r) => r.statut === 'active');
l.push(
  `  ${memoire.lecons.length} leçons  ·  ${actives.length} règles actives  ·  ${memoire.regles.length - actives.length} retirées`,
);

const enAttente = entrees.filter((e) => e.verdict !== 'attendre' && !e.resultat);
if (enAttente.length > 0) {
  l.push('', `  ${enAttente.length} trade(s) sans résultat : ${enAttente.map((e) => e.id).join(', ')}`);
}

l.push(barre, '');
process.stdout.write(`${l.join('\n')}\n`);
