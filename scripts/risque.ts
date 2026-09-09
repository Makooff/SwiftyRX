/**
 * `npm run risque` — le moteur de risque en ligne de commande.
 *
 * C'est par ici que l'agent `risque` obtient sa décision. Le calcul n'est pas
 * fait par un modèle : il est fait par du code qui ne lit ni la capture
 * d'écran ni le raisonnement, seulement des nombres.
 *
 *   npm run risque -- --paire BTC/USD --sens achat --setup retest \
 *     --entree 78400 --stop 77950 --cible 79100 --qualite 0.68
 *
 * Ajouter `--json` pour la sortie machine.
 */

import { MoteurRisque } from '../src/risk/engine.js';
import { estSetup, type Sens, type Setup } from '../src/risk/types.js';
import { Compte } from '../src/journal/state.js';
import { Journal } from '../src/journal/journal.js';
import { statsParSetup } from '../src/journal/stats.js';
import { chargerMemoire } from '../src/memory/store.js';
import { reglesApplicables } from '../src/memory/rules.js';
import { lirePaire } from '../src/risk/instrument.js';
import { exiger, lireArgs, nombre, texte } from './args.js';

const args = lireArgs();

const paireBrute = texte(args, 'paire');
const sensBrut = texte(args, 'sens');
const setupBrut = texte(args, 'setup');
const entree = nombre(args, 'entree');
const stop = nombre(args, 'stop');
const cible = nombre(args, 'cible');
const cible2 = nombre(args, 'cible2');
const qualite = nombre(args, 'qualite');

exiger(paireBrute, 'paire', 'BTC/USD');
exiger(sensBrut, 'sens', 'achat');
exiger(setupBrut, 'setup', 'retest');
exiger(entree, 'entree', '78400');
exiger(stop, 'stop', '77950');
exiger(cible, 'cible', '79100');
exiger(qualite, 'qualite', '0.68');

if (sensBrut !== 'achat' && sensBrut !== 'vente') {
  process.stderr.write(`--sens doit valoir « achat » ou « vente », reçu « ${sensBrut} »\n`);
  process.exit(2);
}
if (!estSetup(setupBrut!)) {
  process.stderr.write(
    `--setup « ${setupBrut} » n'est pas dans la taxonomie. Les setups reconnus sont : cassure, retest, rejet_niveau, retournement_range, continuation_tendance, divergence, liquidite, news, contre_tendance.\n`,
  );
  process.exit(2);
}

const sens = sensBrut as Sens;
const setup = setupBrut as Setup;

const paire = lirePaire(paireBrute!);
if (!paire) {
  process.stderr.write(
    `paire « ${paireBrute} » non reconnue. Écris-la comme BTC/USD, EURUSD, XAU/USD. Ne devine pas : une mauvaise classe d'actif fausse la taille.\n`,
  );
  process.exit(2);
}

const compte = new Compte();
const journal = new Journal();
const memoire = await chargerMemoire();

const etat = await compte.charger();
const entrees = await journal.lireTout();
const stats = statsParSetup(entrees, setup);

const regles = reglesApplicables(memoire, {
  setup,
  symbole: paire.symbole,
  classe: paire.classe === 'inconnu' ? 'crypto' : paire.classe,
  heureUtc: new Date().getUTCHours(),
});

const moteur = new MoteurRisque();
const decision = moteur.evaluer(
  {
    symbole: paire.symbole,
    sens,
    setup,
    qualite: qualite!,
    prixEntree: entree!,
    prixStop: stop!,
    prixCible: cible!,
    ...(cible2 !== undefined ? { prixCible2: cible2 } : {}),
    ...(nombre(args, 'taux') !== undefined ? { tauxDeviseCompte: nombre(args, 'taux')! } : {}),
    echantillonSetup: stats.n,
    ...(stats.n > 0 ? { esperanceSetup: stats.esperanceR } : {}),
    reglesApprises: regles.map((r) => ({ id: r.id, action: r.action, motif: r.enonce })),
  },
  etat,
);

if (args.json) {
  process.stdout.write(`${JSON.stringify({ decision, etat, stats, regles: regles.map((r) => r.id) }, null, 2)}\n`);
  process.exit(decision.verdict === 'refuse' ? 1 : 0);
}

const e = (n: number) => `${n.toFixed(2)} ${etat.devise}`;

const lignes: string[] = [
  '',
  `${paire.symbole} · ${sens} · ${setup}`,
  `capital ${e(etat.capital)} · plus haut ${e(etat.plusHaut)} · ${etat.pertesConsecutives} pertes d'affilée`,
  '',
];

if (decision.verdict === 'refuse') {
  lignes.push('REFUSÉ', '');
  for (const r of decision.refus) {
    lignes.push(`  ✗ ${r.regle}${r.bloquant ? ' (bloquant)' : ''} — ${r.message}`);
  }
} else {
  lignes.push(
    decision.verdict === 'reduit' ? 'APPROUVÉ, TAILLE RÉDUITE' : 'APPROUVÉ',
    '',
    `  risque      ${decision.risquePct} % du capital = ${e(decision.perteSiStop)}`,
    `  quantité    ${decision.quantite}`,
    `  position    ${e(decision.notionnel)} (levier ${decision.levier})`,
    `  stop        ${decision.distanceStopPct} % sous l'entrée`,
    `  ratio       ${decision.ratio}${decision.ratio2 ? ` puis ${decision.ratio2}` : ''}`,
    `  frais       ${(decision.fraisEnR * 100).toFixed(0)} % du risque`,
    '',
  );
  if (decision.conversionSupposee) {
    lignes.push(
      `  ⚠ taille exprimée en ${paire.cotation}, pas en ${etat.devise} : passe --taux pour convertir`,
      '',
    );
  }
  if (decision.facteursRisque.length > 1) {
    lignes.push('  ce qui a fait baisser le risque :');
    for (const f of decision.facteursRisque.slice(1)) {
      lignes.push(`    · ${f.detail}`);
    }
  }
}

lignes.push('', `  ${stats.n} trades mesurés sur « ${setup} » — confiance ${stats.confiance}`, '');
process.stdout.write(`${lignes.join('\n')}\n`);
process.exit(decision.verdict === 'refuse' ? 1 : 0);
