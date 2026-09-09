/**
 * `npm run decision` — écrit une analyse au journal.
 *
 * Prend l'objet JSON sur l'entrée standard :
 *
 *   echo '{ "symbole": "BTC/USD", ... }' | npm run decision
 *
 * Appelé après **chaque** analyse, y compris quand le verdict est « attendre »
 * et y compris quand le moteur de risque a refusé. C'est la règle qui rend le
 * journal honnête : sans les décisions qui n'ont produit aucun trade, on ne
 * garde que ce qu'on a tenté, et le bilan flatte forcément le système.
 *
 * Rend l'identifiant attribué, à reporter dans `npm run resultat --id`.
 */

import { Journal } from '../src/journal/journal.js';
import { Compte } from '../src/journal/state.js';
import { estSetup, type Sens, type Setup } from '../src/risk/types.js';
import { lirePaire } from '../src/risk/instrument.js';
import type { Decision } from '../src/journal/types.js';

interface Entrant {
  symbole: string;
  uniteTemps: string;
  verdict: 'acheter' | 'vendre' | 'attendre';
  setup: string;
  qualite: number;
  prixLu: number;
  sourcePrix?: 'capture' | 'saisie';
  plan?: Decision['plan'];
  dimension?: Decision['dimension'];
  moteur?: Decision['moteur'];
  raisonnement: Decision['raisonnement'];
  veille?: Decision['veille'];
  reglesAppliquees?: string[];
}

async function lireEntree(): Promise<string> {
  const morceaux: Buffer[] = [];
  for await (const morceau of process.stdin) morceaux.push(Buffer.from(morceau));
  return Buffer.concat(morceaux).toString('utf8');
}

const brut = await lireEntree();
if (!brut.trim()) {
  process.stderr.write(
    "rien sur l'entrée standard. Passe l'analyse en JSON :\n  echo '{\"symbole\":\"BTC/USD\", ...}' | npm run decision\n",
  );
  process.exit(2);
}

let entrant: Entrant;
try {
  entrant = JSON.parse(brut) as Entrant;
} catch (err) {
  process.stderr.write(`JSON illisible : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const paire = lirePaire(entrant.symbole);
if (!paire) {
  process.stderr.write(`paire « ${entrant.symbole} » non reconnue.\n`);
  process.exit(2);
}
if (!estSetup(entrant.setup)) {
  process.stderr.write(
    `setup « ${entrant.setup} » hors taxonomie : cassure, retest, rejet_niveau, retournement_range, continuation_tendance, divergence, liquidite, news, contre_tendance.\n`,
  );
  process.exit(2);
}

// Une analyse sans contre-argument ni liste de ce qui n'est pas visible est
// une analyse qui n'a pas cherché à se contredire. Les deux champs sont donc
// obligatoires, et le refus dit pourquoi.
if (!entrant.raisonnement?.contreArgument?.trim()) {
  process.stderr.write(
    "raisonnement.contreArgument est vide. Nomme ce qui ferait échouer ce trade avant de le prendre — c'est la seule ligne du format qui coûte quelque chose à écrire.\n",
  );
  process.exit(2);
}
if (!Array.isArray(entrant.raisonnement.nonVisible) || entrant.raisonnement.nonVisible.length === 0) {
  process.stderr.write(
    "raisonnement.nonVisible est vide. Dis ce que la capture ne montre pas et qui aurait compté : contexte des unités de temps supérieures, volume réel, carnet d'ordres.\n",
  );
  process.exit(2);
}

const journal = new Journal();
const compte = new Compte();
const etat = await compte.charger();

const sens: Sens | null =
  entrant.verdict === 'acheter' ? 'achat' : entrant.verdict === 'vendre' ? 'vente' : null;

const decision = await journal.enregistrer({
  id: await journal.prochainId(),
  symbole: paire.symbole,
  uniteTemps: entrant.uniteTemps,
  verdict: entrant.verdict,
  sens,
  setup: entrant.setup as Setup,
  qualite: entrant.qualite,
  prixLu: entrant.prixLu,
  sourcePrix: entrant.sourcePrix ?? 'capture',
  plan: entrant.plan ?? null,
  dimension: entrant.dimension ?? null,
  moteur: entrant.moteur ?? { verdict: 'non_evalue', refus: [], facteurs: [] },
  raisonnement: entrant.raisonnement,
  veille: entrant.veille ?? [],
  reglesAppliquees: entrant.reglesAppliquees ?? [],
  capitalAvant: etat.capital,
});

if (sens && decision.dimension) {
  const { groupeCorrele, expositionDollar } = await import('../src/risk/instrument.js');
  await compte.ouvrirPosition({
    symbole: paire.symbole,
    sens,
    notionnel: decision.dimension.notionnel,
    risqueOuvert: decision.dimension.montantRisque,
    groupeCorrele: groupeCorrele(paire),
    expositionDollar: expositionDollar(paire, sens),
    ouverteLe: decision.horodatage,
  });
}

process.stdout.write(
  `${decision.id}\n${entrant.verdict === 'attendre' ? "enregistré comme attente — c'est un verdict à part entière, il compte au bilan" : `à reporter : npm run resultat -- --id ${decision.id} --issue gain|perte|neutre`}\n`,
);
