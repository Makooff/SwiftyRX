/**
 * `npm run simulation` — la vérification de bout en bout.
 *
 * Rejoue une séquence écrite de trades dans un dossier temporaire et vérifie
 * que le système se comporte comme annoncé : le capital suit, les arrêts se
 * déclenchent, une règle naît de trois leçons concordantes puis meurt quand
 * les faits la contredisent.
 *
 * Aucune donnée réelle n'est utilisée. Les prix sont écrits en dur, et le
 * point n'est pas de savoir si la stratégie gagne — elle perd, dans ce
 * scénario, exprès — mais si la mécanique dit la vérité sur ce qui s'est
 * passé.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal/journal.js';
import { Compte } from '../src/journal/state.js';
import { bilan } from '../src/journal/stats.js';
import { MoteurRisque } from '../src/risk/engine.js';
import { chargerMemoire, ajouterLecon, ecrireRegles } from '../src/memory/store.js';
import { candidatsPromotion, candidatsRetrogradation, promouvoir, retrograder } from '../src/memory/rules.js';
import type { Setup } from '../src/risk/types.js';

const echecs: string[] = [];
const lignes: string[] = [];

function verifier(nom: string, condition: boolean, constate: string): void {
  lignes.push(`  ${condition ? '✓' : '✗'} ${nom}${condition ? '' : ` — ${constate}`}`);
  if (!condition) echecs.push(`${nom} : ${constate}`);
}

const racine = await mkdtemp(join(tmpdir(), 'copilote-'));
const journal = new Journal({ chemin: join(racine, 'trades.jsonl') });
const compte = new Compte({ chemin: join(racine, 'capital.json') });

lignes.push('', 'SIMULATION', '', `dossier ${racine}`, '');

// --- 1. Le capital suit -----------------------------------------------------
lignes.push('1. Le capital suit les résultats', '');

const sequence: Array<{ setup: Setup; r: number; risque: number }> = [
  { setup: 'retest', r: 2.0, risque: 10 },
  { setup: 'retest', r: -1, risque: 10 },
  { setup: 'cassure', r: 1.5, risque: 12 },
  { setup: 'retest', r: -1, risque: 10 },
];

let attendu = 1000;
for (const [i, t] of sequence.entries()) {
  const id = `T-SIM-${String(i + 1).padStart(3, '0')}`;
  await journal.enregistrer({
    id,
    symbole: 'BTC/USD',
    uniteTemps: '15m',
    verdict: 'acheter',
    sens: 'achat',
    setup: t.setup,
    qualite: 0.7,
    prixLu: 78400,
    sourcePrix: 'capture',
    plan: { entree: 78400, stop: 77950, cible1: 79100, ratio: 1.55 },
    dimension: { risquePct: 1, montantRisque: t.risque, quantite: 0.02, notionnel: 1750, levier: 1.75 },
    moteur: { verdict: 'approuve', refus: [], facteurs: [] },
    raisonnement: {
      contexte: 'simulation',
      declencheur: 'simulation',
      invalidation: 'simulation',
      contreArgument: 'simulation',
      nonVisible: ['tout : ce trade est fabriqué'],
    },
    veille: [],
    reglesAppliquees: [],
    capitalAvant: attendu,
  });

  const pnl = Number((t.r * t.risque).toFixed(2));
  attendu = Number((attendu + pnl).toFixed(2));
  await journal.enregistrerResultat({
    id,
    issue: t.r > 0 ? 'gain' : 'perte',
    prixSortie: t.r > 0 ? 79100 : 77950,
    rRealise: t.r,
    pnl,
    frais: 0,
    capitalApres: attendu,
    motifSortie: 'simulation',
    analyse: {
      declencheurSurvenu: true,
      executionConforme: true,
      stopTropServe: false,
      processus: 'bon',
      leconEnUnePhrase: null,
    },
  });
  await compte.appliquerResultat({ pnl, perte: t.r < 0, symbole: 'BTC/USD' });
}

const etat1 = await compte.charger();
verifier(
  `capital à ${attendu} après 4 trades`,
  etat1.capital === attendu,
  `capital constaté ${etat1.capital}`,
);
verifier('plus haut conservé à 1028 après le repli à 1018', etat1.plusHaut === 1028, `plus haut ${etat1.plusHaut}`);
verifier('1 perte consécutive en cours', etat1.pertesConsecutives === 1, `${etat1.pertesConsecutives}`);

// --- 2. Les arrêts se déclenchent -------------------------------------------
lignes.push('', '2. Les arrêts se déclenchent', '');

const moteur = new MoteurRisque();

const arretsJournee = moteur.conditionsArret({
  ...etat1,
  capital: 950,
  capitalDebutJour: 1000,
});
verifier(
  'arrêt journalier à -5 % de la journée',
  arretsJournee.some((a) => a.regle === 'arret_journalier'),
  `règles déclenchées : ${arretsJournee.map((a) => a.regle).join(', ') || 'aucune'}`,
);

const arretsPertes = moteur.conditionsArret({
  ...etat1,
  pertesConsecutives: 3,
  dernierePerteLe: new Date().toISOString(),
});
verifier(
  'pause après 3 pertes consécutives',
  arretsPertes.some((a) => a.regle === 'pause_apres_pertes'),
  `règles déclenchées : ${arretsPertes.map((a) => a.regle).join(', ') || 'aucune'}`,
);

const refus = moteur.evaluer(
  {
    symbole: 'BTC/USD',
    sens: 'achat',
    setup: 'retest',
    qualite: 0.9,
    prixEntree: 78400,
    prixStop: 77950,
    prixCible: 78500,
  },
  etat1,
);
verifier(
  'un ratio de 0,22 est refusé même avec une qualité de 0,9',
  refus.verdict === 'refuse' && refus.refus.some((r) => r.regle === 'ratio_minimum'),
  `verdict ${refus.verdict}`,
);

const plafond = moteur.evaluer(
  {
    symbole: 'BTC/USD',
    sens: 'achat',
    setup: 'retest',
    qualite: 1,
    prixEntree: 78400,
    prixStop: 77950,
    prixCible: 80000,
  },
  { ...etat1, positions: [] },
);
verifier(
  'le risque ne dépasse jamais 2 % même à qualité maximale',
  plafond.risquePct <= 2,
  `risque ${plafond.risquePct} %`,
);

const stopEnvers = moteur.evaluer(
  {
    symbole: 'EUR/USD',
    sens: 'achat',
    setup: 'cassure',
    qualite: 0.8,
    prixEntree: 1.08,
    prixStop: 1.09,
    prixCible: 1.1,
  },
  etat1,
);
verifier(
  'un stop du mauvais côté est refusé',
  stopEnvers.refus.some((r) => r.regle === 'stop_du_bon_cote'),
  `verdict ${stopEnvers.verdict}`,
);

// --- 3. Une règle naît, puis meurt ------------------------------------------
lignes.push('', '3. Une règle naît de trois leçons, puis meurt', '');

for (let i = 1; i <= 2; i++) {
  await ajouterLecon(
    {
      horodatage: new Date().toISOString(),
      tradeId: `T-SIM-L${i}`,
      setup: 'retest',
      sens: 'achat',
      symbole: 'EUR/USD',
      etiquette: 'session_asiatique',
      texte: "un retest de cassure en session asiatique sur les majeures n'a pas le volume pour tenir",
      rRealise: -1,
    },
    racine,
  );
}

let memoire = await chargerMemoire(racine);
verifier(
  'deux leçons ne suffisent pas',
  candidatsPromotion(memoire).length === 0,
  `${candidatsPromotion(memoire).length} candidat(s)`,
);

await ajouterLecon(
  {
    horodatage: new Date().toISOString(),
    tradeId: 'T-SIM-L3',
    setup: 'retest',
    sens: 'achat',
    symbole: 'EUR/USD',
    etiquette: 'session_asiatique',
    texte: "un retest de cassure en session asiatique sur les majeures n'a pas le volume pour tenir",
    rRealise: -1,
  },
  racine,
);

memoire = await chargerMemoire(racine);
const candidats = candidatsPromotion(memoire);
verifier('la troisième leçon concordante promeut une règle', candidats.length === 1, `${candidats.length}`);
verifier(
  'une espérance de -1 R donne un refus, pas une réduction',
  candidats[0]?.action === 'refuser',
  `action ${candidats[0]?.action}`,
);

if (candidats[0]) {
  const regle = promouvoir(candidats[0], memoire, new Date());
  memoire = { ...memoire, regles: [regle] };
  await ecrireRegles(memoire.regles, racine);

  verifier(
    "une règle ne peut que refuser ou réduire",
    regle.action === 'refuser' || regle.action === 'reduire',
    `action ${regle.action}`,
  );

  // Trois trades que la règle a écartés et qui auraient gagné : elle coûte.
  memoire = {
    ...memoire,
    regles: [
      {
        ...regle,
        suivi: [
          { tradeId: 'A', rRealise: 2, filtre: true },
          { tradeId: 'B', rRealise: 1.5, filtre: true },
          { tradeId: 'C', rRealise: 3, filtre: true },
        ],
      },
    ],
  };
  const sorties = candidatsRetrogradation(memoire);
  verifier(
    'trois trades écartés qui auraient gagné retirent la règle',
    sorties.length === 1,
    `${sorties.length} rétrogradation(s)`,
  );
  if (sorties[0]) {
    const retiree = retrograder(sorties[0].regle, sorties[0].motif, new Date());
    verifier('la règle retirée garde son motif', retiree.motifRetrogradation !== undefined, 'motif absent');
  }
}

// --- 4. Les attentes comptent -----------------------------------------------
lignes.push('', '4. Les attentes laissent une trace', '');

await journal.enregistrer({
  id: 'T-SIM-ATT',
  symbole: 'EUR/USD',
  uniteTemps: '15m',
  verdict: 'attendre',
  sens: null,
  setup: 'retournement_range',
  qualite: 0.3,
  prixLu: 1.085,
  sourcePrix: 'capture',
  plan: null,
  dimension: null,
  moteur: { verdict: 'refuse', refus: ['ratio_minimum'], facteurs: [] },
  raisonnement: {
    contexte: 'simulation',
    declencheur: 'aucun',
    invalidation: 'sans objet',
    contreArgument: 'simulation',
    nonVisible: ['tout'],
  },
  veille: [],
  reglesAppliquees: [],
  capitalAvant: attendu,
});

const final = bilan(await journal.lireTout());
verifier("l'attente est enregistrée", final.attentes === 1, `${final.attentes} attente(s)`);
verifier(
  "l'attente ne compte pas comme un trade",
  final.trades === 4,
  `${final.trades} trades comptés`,
);
verifier(
  'le refus du moteur est tracé',
  final.refusMoteur === 1,
  `${final.refusMoteur} refus tracé(s)`,
);

// --- Fin --------------------------------------------------------------------
await rm(racine, { recursive: true, force: true });

lignes.push(
  '',
  echecs.length === 0
    ? `Tout passe. ${lignes.filter((l) => l.includes('✓')).length} vérifications.`
    : `${echecs.length} échec(s) :`,
  ...echecs.map((e) => `  ${e}`),
  '',
);

process.stdout.write(`${lignes.join('\n')}\n`);
process.exit(echecs.length === 0 ? 0 : 1);
