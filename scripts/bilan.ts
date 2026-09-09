/**
 * `npm run bilan` — le moment où la mémoire bouge.
 *
 * Trois choses, dans cet ordre :
 *
 *  1. Met à jour le suivi des règles avec les trades dénoués depuis la
 *     dernière fois.
 *  2. Retire les règles que les faits ne soutiennent plus, **avant** d'en
 *     promouvoir de nouvelles. Dans l'autre sens, le plafond de règles serait
 *     atteint par des règles périmées.
 *  3. Promeut les groupes de trois leçons concordantes.
 *
 * Puis régénère `memoire/regles.md` et `memoire/setups.md`.
 *
 * `--sec` fait tourner l'analyse sans rien écrire.
 */

import { Journal } from '../src/journal/journal.js';
import { bilan as calculerBilan, coutDeLaPrudence } from '../src/journal/stats.js';
import { Compte, drawdownPct } from '../src/journal/state.js';
import { chargerMemoire, ecrireRegles, ecrireVues } from '../src/memory/store.js';
import {
  candidatsPromotion,
  candidatsRetrogradation,
  promouvoir,
  retrograder,
  suivreRegles,
  tropDeRegles,
} from '../src/memory/rules.js';
import { lirePaire } from '../src/risk/instrument.js';
import { LIBELLE_SETUP } from '../src/risk/types.js';
import { ECHANTILLON } from '../src/settings.js';
import { lireArgs } from './args.js';

const args = lireArgs();
const sec = args.sec === true;

const journal = new Journal();
const compte = new Compte();
let memoire = await chargerMemoire();

const entrees = await journal.lireTout();
const etat = await compte.charger();
const stats = calculerBilan(entrees);
const prudence = coutDeLaPrudence(entrees);

// --- 1. Suivi ---------------------------------------------------------------
for (const entree of entrees) {
  if (!entree.resultat) continue;
  const paire = lirePaire(entree.symbole);
  if (!paire) continue;
  memoire = suivreRegles(memoire, entree, {
    setup: entree.setup,
    symbole: paire.symbole,
    classe: paire.classe === 'inconnu' ? 'crypto' : paire.classe,
    heureUtc: new Date(entree.horodatage).getUTCHours(),
  });
}

const maintenant = new Date();

// --- 2. Rétrogradations avant promotions ------------------------------------
const sorties = candidatsRetrogradation(memoire);
for (const { regle, motif } of sorties) {
  memoire = {
    ...memoire,
    regles: memoire.regles.map((r) => (r.id === regle.id ? retrograder(r, motif, maintenant) : r)),
  };
}

// --- 3. Promotions ----------------------------------------------------------
const candidats = candidatsPromotion(memoire);
const promues: string[] = [];
for (const candidat of candidats) {
  if (tropDeRegles(memoire)) break;
  const regle = promouvoir(candidat, memoire, maintenant);
  memoire = { ...memoire, regles: [...memoire.regles, regle] };
  promues.push(`${regle.id} — ${regle.enonce}`);
}

if (!sec) {
  await ecrireRegles(memoire.regles);
  await ecrireVues(memoire, stats);
}

// --- Rapport ----------------------------------------------------------------
const l: string[] = ['', `BILAN · ${maintenant.toISOString().slice(0, 16).replace('T', ' ')}`, ''];

l.push(
  `capital ${etat.capital.toFixed(2)} ${etat.devise} · plus haut ${etat.plusHaut.toFixed(2)} · drawdown ${drawdownPct(etat)} %`,
  '',
);

if (stats.trades === 0) {
  l.push(
    `${stats.decisions} décisions enregistrées, aucun trade dénoué.`,
    "Rien n'est mesurable et rien ne sera affirmé.",
    '',
  );
} else {
  l.push(
    `${stats.trades} trades dénoués · ${stats.gains} gains · ${stats.pertes} pertes · ${stats.tauxReussitePct} %`,
    `espérance ${stats.esperanceR} R par trade, ${stats.esperanceNetteR} R une fois les frais payés`,
    `cumul ${stats.cumulR > 0 ? '+' : ''}${stats.cumulR} R · frais totaux ${stats.fraisTotaux} ${etat.devise} · pire série ${stats.pireSerie}`,
    '',
  );

  if (stats.trades < ECHANTILLON.minimumPourRegler) {
    l.push(
      `⚠ ${stats.trades} trades, il en faut ${ECHANTILLON.minimumPourRegler} avant qu'un chiffre ici serve à décider quoi que ce soit.`,
      '',
    );
  }

  if (stats.esperanceR > 0 && stats.esperanceNetteR <= 0) {
    l.push(
      "⚠ L'espérance est positive avant frais et nulle ou négative après.",
      "Ces trades ne rapportent rien : ils déplacent de l'argent vers le broker.",
      '',
    );
  }

  l.push('Par setup :', '');
  for (const s of [...stats.parSetup].sort((a, b) => b.esperanceR - a.esperanceR)) {
    l.push(
      `  ${LIBELLE_SETUP[s.setup].padEnd(38)} n=${String(s.n).padStart(3)}  ${String(s.tauxReussitePct).padStart(5)} %  ${s.esperanceR > 0 ? '+' : ''}${s.esperanceR} R  ${s.confiance}`,
    );
  }
  l.push('');
}

if (prudence.ecartes > 0) {
  l.push(
    `Le prix de la prudence : ${prudence.ecartes} trades écartés, ${prudence.suivis} suivis après coup.`,
  );
  if (prudence.suivis > 0) {
    l.push(
      `  ${prudence.auraientGagne} auraient gagné, ${prudence.auraientPerdu} auraient perdu, soit ${prudence.rManques > 0 ? '+' : ''}${prudence.rManques} R.`,
    );
  } else {
    l.push(
      "  Aucun n'a été suivi, donc on ne sait pas si refuser coûte ou rapporte. C'est l'angle mort du système.",
    );
  }
  l.push('');
}

if (sorties.length > 0) {
  l.push('Règles retirées :', '');
  for (const { regle, motif } of sorties) l.push(`  ${regle.id} — ${motif}`);
  l.push('');
}

if (promues.length > 0) {
  l.push('Règles promues :', '');
  for (const p of promues) l.push(`  ${p}`);
  l.push('');
} else if (candidats.length > 0) {
  l.push('Des candidats attendent mais le plafond de règles est atteint. Arbitre avant.', '');
} else {
  const groupes = new Map<string, number>();
  for (const lecon of memoire.lecons) {
    const cle = `${lecon.setup}|${lecon.etiquette}`;
    groupes.set(cle, (groupes.get(cle) ?? 0) + 1);
  }
  const proches = [...groupes.entries()].filter(([, n]) => n === ECHANTILLON.leconsPourPromouvoir - 1);
  if (proches.length > 0) {
    l.push(
      `Aucune promotion. ${proches.length} groupe(s) de leçons à une occurrence du seuil :`,
      ...proches.map(([cle]) => `  ${cle.replace('|', ' / ')}`),
      '',
    );
  } else {
    l.push(
      `Aucune promotion. ${memoire.lecons.length} leçons enregistrées, il en faut ${ECHANTILLON.leconsPourPromouvoir} concordantes.`,
      '',
    );
  }
}

if (sec) l.push('(--sec : rien n\'a été écrit)', '');
else l.push('memoire/regles.md et memoire/setups.md régénérés.', '');

process.stdout.write(`${l.join('\n')}\n`);
