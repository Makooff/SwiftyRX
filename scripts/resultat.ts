/**
 * `npm run resultat` — ce qui s'est réellement passé.
 *
 * Met à jour le capital, écrit le résultat au journal, et enregistre la leçon
 * si elle en est une.
 *
 *   npm run resultat -- --id T-2026-09-09-001 --issue gain --sortie 79100 \
 *     --declencheur oui --execution oui --stop-serre non --processus bon \
 *     --etiquette retest_volume --lecon "..."
 *
 * Le R réalisé est **calculé** à partir du plan et du prix de sortie, pas
 * saisi. Un R saisi à la main est un R arrondi dans le sens qui arrange, et
 * c'est précisément le chiffre sur lequel tout le reste repose.
 */

import { Journal } from '../src/journal/journal.js';
import { Compte } from '../src/journal/state.js';
import { ajouterLecon, leconRecevable } from '../src/memory/store.js';
import type { Issue } from '../src/journal/types.js';
import { BORNES } from '../src/settings.js';
import { exiger, lireArgs, nombre, texte } from './args.js';

const args = lireArgs();
const id = texte(args, 'id');
const issueBrute = texte(args, 'issue');
exiger(id, 'id', 'T-2026-09-09-001');
exiger(issueBrute, 'issue', 'gain');

const ISSUES = ['gain', 'perte', 'neutre', 'non_pris'];
if (!ISSUES.includes(issueBrute!)) {
  process.stderr.write(`--issue doit valoir ${ISSUES.join(', ')} — reçu « ${issueBrute} »\n`);
  process.exit(2);
}
const issue = issueBrute as Issue;

const journal = new Journal();
const compte = new Compte();

const entrees = await journal.lireTout();
const entree = entrees.find((e) => e.id === id);
if (!entree) {
  process.stderr.write(
    `aucune décision « ${id} » au journal. Les dernières sont : ${entrees.slice(-5).map((e) => e.id).join(', ') || 'aucune'}\n`,
  );
  process.exit(2);
}
if (entree.resultat) {
  process.stderr.write(
    `⚠ « ${id} » a déjà un résultat (${entree.resultat.issue}). Le nouveau le remplacera à la lecture ; les deux restent dans le fichier.\n`,
  );
}

const prixSortie = nombre(args, 'sortie') ?? null;

/**
 * Le R réalisé.
 *
 * Compté sur la distance au stop, avec le signe du sens. Marche identiquement
 * à l'achat et à la vente, ce qui n'est pas le cas d'un calcul en pourcentage.
 */
function calculerR(): number {
  const force = nombre(args, 'r');
  if (force !== undefined) return force;
  if (issue === 'non_pris') return 0;
  if (!entree!.plan || prixSortie === null) return issue === 'perte' ? -1 : 0;

  const { entree: pe, stop } = entree!.plan;
  const risque = Math.abs(pe - stop);
  if (risque <= 0) return 0;
  const signe = entree!.sens === 'vente' ? -1 : 1;
  return Number((((prixSortie - pe) * signe) / risque).toFixed(3));
}

const rRealise = calculerR();
const montantRisque = entree.dimension?.montantRisque ?? 0;
const frais =
  nombre(args, 'frais') ??
  Number((((entree.dimension?.notionnel ?? 0) * BORNES.fraisParDefautPct) / 100).toFixed(2));

const pnl =
  nombre(args, 'pnl') ??
  (issue === 'non_pris' ? 0 : Number((rRealise * montantRisque - frais).toFixed(2)));

const etat = await compte.charger();
const capitalApres =
  issue === 'non_pris' ? etat.capital : Number((etat.capital + pnl).toFixed(2));

const ouiNon = (cle: string, defaut: boolean): boolean => {
  const v = texte(args, cle);
  if (v === undefined) return defaut;
  return /^(oui|o|yes|y|true|1)$/i.test(v);
};

const processusBrut = texte(args, 'processus') ?? (issue === 'gain' ? 'bon' : 'bon');
const leconTexte = texte(args, 'lecon');
const etiquette = texte(args, 'etiquette');

// Une leçon sans étiquette ne pourra jamais concorder avec une autre, donc ne
// produira jamais de règle. Autant le dire tout de suite.
if (leconTexte && !etiquette) {
  process.stderr.write(
    "--lecon sans --etiquette : la leçon sera écrite mais ne pourra jamais être promue en règle.\nDonne une étiquette courte en snake_case, réutilisable, par exemple : session_asiatique, volume_faible, contre_htf.\n",
  );
  process.exit(2);
}

if (leconTexte) {
  const jugement = leconRecevable(leconTexte);
  if (!jugement.ok) {
    process.stderr.write(
      `leçon refusée : ${jugement.motif}\nUne leçon doit nommer une condition observable. « il faut être plus patient » n'en est pas une ; « un retest en session asiatique sur les majeures n'a pas le volume pour tenir » en est une.\n`,
    );
    process.exit(2);
  }
}

await journal.enregistrerResultat({
  id: id!,
  issue,
  prixSortie,
  rRealise,
  pnl,
  frais,
  capitalApres,
  motifSortie: texte(args, 'motif') ?? '',
  analyse: {
    declencheurSurvenu: ouiNon('declencheur', true),
    executionConforme: ouiNon('execution', true),
    stopTropServe: ouiNon('stop-serre', false),
    processus: processusBrut === 'mauvais' ? 'mauvais' : 'bon',
    leconEnUnePhrase: leconTexte ?? null,
  },
});

if (issue !== 'non_pris') {
  await compte.appliquerResultat({
    pnl,
    perte: rRealise < 0,
    symbole: entree.symbole,
  });
}

let leconId: string | undefined;
if (leconTexte && etiquette) {
  const lecon = await ajouterLecon({
    horodatage: new Date().toISOString(),
    tradeId: id!,
    setup: entree.setup,
    sens: entree.sens,
    symbole: entree.symbole,
    etiquette,
    texte: leconTexte,
    rRealise,
  });
  leconId = lecon.id;
}

const l = [
  '',
  `${id} · ${entree.symbole} · ${issue}`,
  `  R réalisé   ${rRealise > 0 ? '+' : ''}${rRealise}`,
  `  résultat    ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} ${etat.devise} (frais ${frais.toFixed(2)})`,
  `  capital     ${etat.capital.toFixed(2)} → ${capitalApres.toFixed(2)} ${etat.devise}`,
];

const processus = processusBrut === 'mauvais' ? 'mauvais' : 'bon';
if (issue === 'gain' && processus === 'mauvais') {
  l.push('', '  ⚠ gagné avec un mauvais processus. Le résultat flatte la méthode : ne la répète pas.');
}
if (issue === 'perte' && processus === 'bon') {
  l.push('', '  Perdu avec un bon processus. Rien à corriger ici — ce trade était à prendre.');
}
if (ouiNon('stop-serre', false)) {
  l.push('  Stop touché avant que le prix reparte : c\'est le placement du stop, pas l\'analyse.');
}
if (leconId) l.push('', `  leçon ${leconId} enregistrée sous « ${etiquette} »`);

l.push('', '  Lance `npm run bilan` pour voir si cette leçon en promeut une règle.', '');
process.stdout.write(`${l.join('\n')}\n`);
