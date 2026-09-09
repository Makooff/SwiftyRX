/**
 * `npm run resultat` — ce qui s'est réellement passé, en ligne de commande.
 *
 *   npm run resultat -- --id T-2026-09-09-001 --issue gain --sortie 79100 \
 *     --etiquette retest_volume --lecon "..."
 *
 * Le calcul vit dans `src/journal/resultat.ts`, partagé avec l'application :
 * deux implémentations du R finiraient par diverger, et c'est le chiffre sur
 * lequel tout le reste repose.
 */

import { enregistrerResultat, ResultatRefuse } from '../src/journal/resultat.js';
import type { Issue } from '../src/journal/types.js';
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

const ouiNon = (cle: string, defaut: boolean): boolean => {
  const v = texte(args, cle);
  if (v === undefined) return defaut;
  return /^(oui|o|yes|y|true|1)$/i.test(v);
};

try {
  const r = await enregistrerResultat({
    id: id!,
    issue: issueBrute as Issue,
    ...(nombre(args, 'sortie') !== undefined ? { prixSortie: nombre(args, 'sortie')! } : {}),
    ...(nombre(args, 'r') !== undefined ? { rForce: nombre(args, 'r')! } : {}),
    ...(nombre(args, 'frais') !== undefined ? { frais: nombre(args, 'frais')! } : {}),
    ...(texte(args, 'motif') ? { motifSortie: texte(args, 'motif')! } : {}),
    ...(texte(args, 'etiquette') ? { etiquette: texte(args, 'etiquette')! } : {}),
    analyse: {
      declencheurSurvenu: ouiNon('declencheur', true),
      executionConforme: ouiNon('execution', true),
      stopTropServe: ouiNon('stop-serre', false),
      processus: texte(args, 'processus') === 'mauvais' ? 'mauvais' : 'bon',
      leconEnUnePhrase: texte(args, 'lecon') ?? null,
    },
  });

  const l = [
    '',
    `${r.id} · ${issueBrute}`,
    `  R réalisé   ${r.rRealise > 0 ? '+' : ''}${r.rRealise}`,
    `  résultat    ${r.pnl > 0 ? '+' : ''}${r.pnl.toFixed(2)} (frais ${r.frais.toFixed(2)})`,
    `  capital     ${r.capitalAvant.toFixed(2)} → ${r.capitalApres.toFixed(2)}`,
    ...(r.remarques.length > 0 ? ['', ...r.remarques.map((x) => `  ${x}`)] : []),
    ...(r.leconId ? ['', `  leçon ${r.leconId} enregistrée`] : []),
    '',
    '  Lance `npm run bilan` pour voir si cette leçon en promeut une règle.',
    '',
  ];
  process.stdout.write(`${l.join('\n')}\n`);
} catch (err) {
  if (err instanceof ResultatRefuse) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
