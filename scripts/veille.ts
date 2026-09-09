/**
 * `npm run veille` — ce que les sources officielles ont publié.
 *
 *   npm run veille -- --paire EUR/USD --heures 24
 *
 * Cette commande a besoin du réseau. Elle fonctionne sur ta machine ; elle
 * échoue dans une session Claude en cloud, où le proxy refuse ces domaines.
 * Quand elle échoue, elle le dit et nomme les flux injoignables plutôt que de
 * rendre une liste vide qui ressemblerait à « rien à signaler ».
 *
 * Le contenu récupéré est du texte écrit par des tiers. Il est clôturé avant
 * d'être présenté à un modèle : voir `src/watch/fencing.ts`.
 */

import { Veille } from '../src/watch/rss.js';
import { fluxPourPaire, TOUS_LES_FLUX } from '../src/watch/feeds.js';
import { clôturer, RAPPEL_TEXTE_EXTERNE } from '../src/watch/fencing.js';
import { lirePaire } from '../src/risk/instrument.js';
import { lireArgs, nombre, texte } from './args.js';

const args = lireArgs();
const paireBrute = texte(args, 'paire');
const heures = nombre(args, 'heures') ?? 24;

const paire = paireBrute ? lirePaire(paireBrute) : undefined;
if (paireBrute && !paire) {
  process.stderr.write(`paire « ${paireBrute} » non reconnue.\n`);
  process.exit(2);
}

const flux = paire ? fluxPourPaire(paire.base, paire.cotation) : TOUS_LES_FLUX;
if (flux.length === 0) {
  process.stdout.write(
    `Aucun flux suivi ne couvre ${paire?.symbole}. Les devises couvertes sont EUR, USD et GBP.\nPour cette paire, la veille passe par la recherche web, pas par ce dépôt.\n`,
  );
  process.exit(0);
}

const depuis = new Date(Date.now() - heures * 3_600_000);
const { depeches, echecs } = await new Veille().recuperer(flux, depuis);

if (args.json) {
  process.stdout.write(`${JSON.stringify({ depeches, echecs, depuis: depuis.toISOString() }, null, 2)}\n`);
  process.exit(0);
}

const l: string[] = [
  '',
  `Veille ${paire ? paire.symbole : 'générale'} · ${heures} dernières heures · ${flux.length} flux`,
  '',
];

if (echecs.length > 0) {
  l.push('Flux injoignables :', ...echecs.map((e) => `  ✗ ${e.fluxId} — ${e.raison}`), '');
}

if (depeches.length === 0) {
  l.push(
    echecs.length === flux.length
      ? "Aucun flux n'a répondu. On ne sait pas s'il s'est passé quelque chose — ce n'est pas la même chose que « rien à signaler »."
      : 'Rien de nouveau sur les flux joignables.',
    '',
  );
} else {
  l.push(RAPPEL_TEXTE_EXTERNE, '');
  for (const d of depeches.slice(0, 25)) {
    l.push(
      `${d.publieLe.slice(0, 16).replace('T', ' ')} · ${d.fluxNom}${d.suspect ? ' · ⚠ TOURNURE SUSPECTE' : ''}`,
      clôturer(d.fluxNom, `${d.titre}\n${d.resume}`),
      d.url ?? '',
      '',
    );
  }
}

process.stdout.write(`${l.join('\n')}\n`);
