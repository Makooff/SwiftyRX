/**
 * `npm run contexte` — ce que la mémoire sait avant une analyse.
 *
 * Appelé par l'agent `memoire` au début de chaque analyse. Rend les règles
 * apprises qui s'appliquent, les statistiques du setup, et l'état du capital.
 *
 *   npm run contexte -- --paire BTC/USD --setup retest
 *
 * Sans `--setup`, rend le tableau complet : utile quand Claude n'a pas encore
 * décidé de quel setup il s'agit et veut voir ce qui marche en ce moment.
 */

import { Journal } from '../src/journal/journal.js';
import { bilan, statsParSetup } from '../src/journal/stats.js';
import { Compte, drawdownPct } from '../src/journal/state.js';
import { chargerMemoire } from '../src/memory/store.js';
import { reglesApplicables, tropDeRegles } from '../src/memory/rules.js';
import { lirePaire } from '../src/risk/instrument.js';
import { estSetup, LIBELLE_SETUP, type Setup } from '../src/risk/types.js';
import { BORNES } from '../src/settings.js';
import { MoteurRisque } from '../src/risk/engine.js';
import { lireArgs, texte } from './args.js';

const args = lireArgs();
const paireBrute = texte(args, 'paire');
const setupBrut = texte(args, 'setup');

const journal = new Journal();
const compte = new Compte();
const memoire = await chargerMemoire();

const entrees = await journal.lireTout();
const etat = await compte.charger();
const global = bilan(entrees);

const arrets = new MoteurRisque().conditionsArret(etat);

const paire = paireBrute ? lirePaire(paireBrute) : undefined;
const setup = setupBrut && estSetup(setupBrut) ? (setupBrut as Setup) : undefined;

const regles =
  paire && setup
    ? reglesApplicables(memoire, {
        setup,
        symbole: paire.symbole,
        classe: paire.classe === 'inconnu' ? 'crypto' : paire.classe,
        heureUtc: new Date().getUTCHours(),
      })
    : memoire.regles.filter((r) => r.statut === 'active');

if (args.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        etat: { ...etat, drawdownPct: drawdownPct(etat) },
        arrets,
        bornes: BORNES,
        bilan: global,
        statsSetup: setup ? statsParSetup(entrees, setup) : null,
        regles,
        tropDeRegles: tropDeRegles(memoire),
        enAttente: entrees.filter((e) => e.verdict !== 'attendre' && !e.resultat).map((e) => e.id),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const l: string[] = ['', `capital ${etat.capital.toFixed(2)} ${etat.devise}`];
l.push(
  `  départ jour ${etat.capitalDebutJour.toFixed(2)} · départ semaine ${etat.capitalDebutSemaine.toFixed(2)} · plus haut ${etat.plusHaut.toFixed(2)}`,
  `  drawdown ${drawdownPct(etat)} % · ${etat.tradesAujourdhui} trades aujourd'hui · ${etat.pertesConsecutives} pertes d'affilée`,
  '',
);

if (arrets.length > 0) {
  l.push('TRADING ARRÊTÉ', '');
  for (const a of arrets) l.push(`  ✗ ${a.message}`);
  l.push('');
}

if (global.trades === 0) {
  l.push(
    'Aucun trade dénoué. Rien à mesurer.',
    "Le système ne prétendra rien sur ce qui marche tant qu'il n'a pas de résultats.",
    '',
  );
} else {
  l.push(
    `${global.trades} trades · ${global.tauxReussitePct} % de réussite · espérance ${global.esperanceR} R (${global.esperanceNetteR} R nets)`,
    `pire série de pertes : ${global.pireSerie} · ${global.attentes} attentes enregistrées`,
    '',
  );
  if (setup) {
    const s = statsParSetup(entrees, setup);
    l.push(
      `« ${LIBELLE_SETUP[setup]} » : ${s.n} trades, ${s.tauxReussitePct} %, espérance ${s.esperanceR} R — ${s.confiance}`,
      '',
    );
  }
}

const actives = regles.filter((r) => r.statut === 'active');
if (actives.length === 0) {
  l.push('Aucune règle apprise ne s\'applique.', '');
} else {
  l.push(`${actives.length} règle(s) applicable(s) :`, '');
  for (const r of actives) {
    l.push(`  ${r.id} — ${r.action === 'refuser' ? 'REFUSER' : 'réduire'} — ${r.enonce}`);
  }
  l.push('');
}

if (tropDeRegles(memoire)) {
  l.push(
    `⚠ ${BORNES ? '' : ''}Le plafond de règles actives est atteint. Fais un bilan et arbitre avant d'en promouvoir une de plus.`,
    '',
  );
}

process.stdout.write(`${l.join('\n')}\n`);
