/** Lecture des arguments de ligne de commande. Volontairement minimal. */

export type Args = Record<string, string | boolean>;

export function lireArgs(argv = process.argv.slice(2)): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const jeton = argv[i]!;
    if (!jeton.startsWith('--')) continue;
    const [cle, valeurCollee] = jeton.slice(2).split('=', 2);
    if (!cle) continue;
    if (valeurCollee !== undefined) {
      args[cle] = valeurCollee;
      continue;
    }
    const suivant = argv[i + 1];
    if (suivant !== undefined && !suivant.startsWith('--')) {
      args[cle] = suivant;
      i++;
    } else {
      args[cle] = true;
    }
  }
  return args;
}

export function nombre(args: Args, cle: string): number | undefined {
  const brut = args[cle];
  if (typeof brut !== 'string') return undefined;
  const n = Number(brut.replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function texte(args: Args, cle: string): string | undefined {
  const brut = args[cle];
  return typeof brut === 'string' ? brut : undefined;
}

/**
 * Arrête le script avec un message lisible.
 *
 * Un argument manquant est une erreur d'usage, pas un plantage : le message
 * dit ce qui manque et ce qu'il fallait écrire, parce que ces commandes sont
 * appelées par un agent qui doit pouvoir se corriger tout seul.
 */
export function exiger(valeur: number | string | undefined, cle: string, exemple: string): never | void {
  if (valeur === undefined || valeur === '') {
    process.stderr.write(`argument manquant : --${cle}\nexemple : --${cle} ${exemple}\n`);
    process.exit(2);
  }
}
