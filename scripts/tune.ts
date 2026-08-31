#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyToEnvFile, parseEnvFile, parseEnvFileWithComments } from '../src/config/env-file.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { DecisionJournal } from '../src/database/decision-journal.js';
import {
  applyRefusal,
  buildReport,
  isTunable,
  MIN_OUTCOMES_TO_RECOMMEND,
  TUNABLE_KEYS,
  type AppliedRecord,
} from '../src/strategy/tuning.js';

/**
 * Quels reglages le bot recommande, et pourquoi.
 *
 *   npm run tune             affiche les recommandations
 *   npm run tune -- --apply  les ecrit dans le .env, apres sauvegarde
 *
 * En francais, parce que la personne qui lit ceci est celle a qui appartient le
 * bot, pas un collegue.
 *
 * Ce script ne depense aucun token, ne passe aucun ordre et n'ouvre aucune
 * connexion. Il lit le journal de decisions et le compare a la configuration.
 */

const ENV_PATH = '.env';
const RECOMMENDED_PATH = '.env.recommande';
const APPLIED_PATH = 'data/tuning-applied.json';
const HEADING = '# --- ecrit par "npm run tune" ---';

loadEnvFile();

/** An empty value is a real setting, and printing nothing looks like a bug. */
function display(value: string | undefined): string {
  if (value === undefined) return '(absent)';
  return value === '' ? '(vide)' : value;
}

/** Reasons are prose copied out of .env.recommande; a terminal is 80 wide. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const envText = existsSync(ENV_PATH) ? await readFile(ENV_PATH, 'utf8') : '';
if (envText === '') {
  console.log(`\nAucun fichier ${ENV_PATH}. Lance d'abord le bot une fois : il le cree.\n`);
  process.exit(1);
}

const current = parseEnvFile(envText);
const desired = existsSync(RECOMMENDED_PATH)
  ? parseEnvFileWithComments(await readFile(RECOMMENDED_PATH, 'utf8'))
  : {};

const lastApplied: AppliedRecord | undefined = existsSync(APPLIED_PATH)
  ? (JSON.parse(await readFile(APPLIED_PATH, 'utf8')) as AppliedRecord)
  : undefined;

const entries = await new DecisionJournal().readAll();
const report = buildReport(entries, current, desired, new Date());

// --- ce que le journal contient ---------------------------------------------

console.log('\n=== Reglages recommandes ===\n');

const { state } = report;
switch (state.kind) {
  case 'empty':
    console.log("  Le journal est vide : aucune decision n'a encore ete enregistree.");
    console.log('  Il n\'y a donc rien a mesurer, et rien que le bot puisse deduire.');
    break;
  case 'no_outcomes':
    console.log(`  ${state.decisions} decision(s) enregistree(s), aucune encore notee.`);
    console.log('  Une decision se note quand son horizon est passe et que le prix');
    console.log('  d\'arrivee est connu.');
    if (state.duePending > 0) {
      console.log(`  ${state.duePending} attende(nt) deja leur note : lance le bot, il les rattrape.`);
    } else if (state.nextDueAt) {
      console.log(`  La premiere sera notable le ${state.nextDueAt.slice(0, 10)}.`);
    }
    break;
  case 'too_few':
    console.log(`  ${state.decisions} decision(s), dont ${state.outcomes} notee(s).`);
    console.log(`  Il en faut ${MIN_OUTCOMES_TO_RECOMMEND} pour que le bot recommande a partir`);
    console.log('  de ses propres resultats. Ce n\'est pas une prudence inventee ici :');
    console.log('  c\'est exactement le seuil que le scoreur s\'impose deja avant');
    console.log('  d\'utiliser un taux de reussite.');
    break;
  case 'measured':
    console.log(`  ${state.decisions} decision(s), dont ${state.outcomes} notee(s).`);
    console.log('  Assez pour que les recommandations ci-dessous viennent de ce qui');
    console.log('  s\'est reellement passe sur le marche, et non d\'un avis.');
    break;
}

// --- taux de reussite par type d'evenement ----------------------------------

const rates = Object.entries(report.hitRates).sort((a, b) => b[1].sampleSize - a[1].sampleSize);
if (rates.length > 0) {
  console.log('\n--- taux de reussite par type d\'evenement ---');
  const width = Math.max(...rates.map(([type]) => type.length));
  for (const [type, { hitRate, sampleSize }] of rates) {
    // Un type peut etre sous la barre alors que le journal, lui, est au-dessus :
    // 50 resultats au total, c'est assez pour un seuil de score global, pas pour
    // conclure sur chacun des types pris separement.
    const note = sampleSize < MIN_OUTCOMES_TO_RECOMMEND ? '  (trop peu pour ce type)' : '';
    console.log(
      `  ${type.padEnd(width)}  ${String(Math.round(hitRate * 100)).padStart(3)}%  ` +
        `sur ${String(sampleSize).padStart(4)}${note}`,
    );
  }
  console.log('\n  Ces chiffres ne changent aucun reglage ici. Pour qu\'un type');
  console.log('  d\'evenement soit reellement ecarte, c\'est l\'etude d\'evenements qui');
  console.log('  decide : npm run study');
}

// --- les recommandations ----------------------------------------------------

console.log(
  report.basis === 'measured'
    ? '\n--- recommande a partir des resultats mesures ---'
    : '\n--- configuration de depart (choisie a la main, faute de mesure) ---',
);

if (report.basis === 'bootstrap') {
  console.log('  Ces valeurs ne viennent pas d\'une mesure : elles viennent d\'un');
  console.log('  jugement humain, et leur seul but est de produire assez de decisions');
  console.log('  pour que le bot puisse ensuite decider lui-meme. Elles ne touchent ni');
  console.log('  aux limites de risque, ni aux instruments autorises, ni a X/Twitter.\n');
}

if (report.recommendations.length === 0) {
  console.log('  Rien a changer : la configuration correspond deja a la recommandation.');
} else {
  for (const rec of report.recommendations) {
    console.log(`\n  ${rec.key}`);
    console.log(`      actuel      ${display(rec.current)}`);
    console.log(`      recommande  ${rec.recommended}`);
    for (const line of wrap(rec.why, 68)) console.log(`      ${line}`);
  }
}

// --- ce que ce script ne touchera jamais ------------------------------------

console.log('\n--- ce que ce script ne peut pas modifier ---');
console.log("  Il n'ecrit que ces cles :");
for (const line of wrap(TUNABLE_KEYS.join(', '), 68)) console.log(`      ${line}`);
console.log('  Les limites de risque, les instruments autorises, l\'effet de levier,');
console.log('  la vente a decouvert et X/Twitter en sont absents par construction.');
console.log('  Ce sont des questions de tolerance et de facture, pas de performance :');
console.log('  aucun taux de reussite n\'y repond, donc le bot n\'a pas a en decider.');

// --- application ------------------------------------------------------------

const refusal = applyRefusal(report, lastApplied);

if (!apply) {
  console.log('');
  if (refusal) {
    console.log(`  --apply refuserait : ${refusal}`);
  } else if (report.recommendations.length > 0) {
    console.log('  Pour appliquer : npm run tune -- --apply');
    console.log(`  (le ${ENV_PATH} actuel est sauvegarde avant toute ecriture)`);
  }
  console.log('');
  process.exit(0);
}

if (refusal) {
  console.log(`\n  Rien n'a ete ecrit : ${refusal}\n`);
  process.exit(0);
}

// Ceinture et bretelles. buildReport ne produit deja que des cles autorisees ;
// cette verification existe pour que ca reste vrai si quelqu'un ajoute une
// source de recommandations plus tard sans relire tuning.ts.
const forbidden = report.recommendations.filter((rec) => !isTunable(rec.key));
if (forbidden.length > 0) {
  console.error(
    `\n  Abandon : ${forbidden.map((r) => r.key).join(', ')} ne fait pas partie des cles autorisees.\n`,
  );
  process.exit(1);
}

const backup = `${ENV_PATH}.avant-tune`;
await copyFile(ENV_PATH, backup);

const changes = Object.fromEntries(report.recommendations.map((rec) => [rec.key, rec.recommended]));
await writeFile(ENV_PATH, applyToEnvFile(envText, changes, HEADING), 'utf8');

const outcomes = report.state.kind === 'measured' || report.state.kind === 'too_few' ? report.state.outcomes : 0;
await mkdir(dirname(APPLIED_PATH), { recursive: true });
await writeFile(
  APPLIED_PATH,
  `${JSON.stringify(
    {
      appliedAt: new Date().toISOString(),
      basis: report.basis,
      outcomes,
      keys: Object.keys(changes),
    } satisfies AppliedRecord,
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`\n  Applique. Ancienne version sauvegardee : ${backup}`);
for (const rec of report.recommendations) {
  console.log(`    ${rec.key} : ${display(rec.current)} -> ${rec.recommended}`);
}
console.log('\n  Relance le bot pour que les nouveaux reglages prennent effet.\n');
