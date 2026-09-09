/**
 * La mémoire : des leçons, et les règles qu'elles finissent par produire.
 *
 * La distinction entre les deux est tout le mécanisme. Une **leçon** est une
 * observation sur un trade : elle n'agit sur rien. Une **règle** agit sur les
 * analyses suivantes, et pour en devenir une il faut que trois leçons
 * indépendantes disent la même chose.
 *
 * Sans ce seuil, le système change de comportement après chaque trade et
 * apprend le bruit. Avec, il lui faut une régularité avant de bouger.
 */

import type { Setup, Sens } from '../risk/types.js';

/**
 * Une leçon tirée d'un trade dénoué.
 *
 * `etiquette` est le champ qui fait fonctionner la promotion : c'est un mot-clé
 * court, réutilisé à l'identique d'une leçon à l'autre, qui permet de compter
 * les concordances. Deux leçons formulées différemment mais étiquetées
 * `session_asiatique` concordent ; deux belles phrases sans étiquette commune
 * ne concordent jamais et ne produisent rien.
 */
export interface Lecon {
  id: string;
  horodatage: string;
  /** La décision dont elle vient. */
  tradeId: string;
  setup: Setup;
  sens: Sens | null;
  symbole: string;
  /** Mot-clé court en snake_case, réutilisé tel quel entre leçons. */
  etiquette: string;
  /** La leçon, en une phrase. Spécifique et testable, sinon elle est refusée. */
  texte: string;
  /** Le R réalisé sur ce trade, qui dit dans quel sens la leçon penche. */
  rRealise: number;
}

export type StatutRegle = 'active' | 'retrogradee';

/**
 * Une règle appliquée avant chaque analyse.
 *
 * `action` ne peut valoir que `refuser` ou `reduire`. Il n'existe
 * volontairement pas de valeur `autoriser` ni `augmenter`.
 *
 * Une mémoire qui peut lever ses propres garde-fous les lèvera : il suffit de
 * quelques trades gagnants sur un setup pour produire une justification, et
 * ces trades arrivent par hasard aussi souvent que par méthode. Le carnet de
 * preuves de la version précédente du projet avait déjà cette asymétrie, pour
 * la même raison ; elle est reprise telle quelle.
 */
export interface Regle {
  id: string;
  enonce: string;
  action: 'refuser' | 'reduire';
  /** Ce qui déclenche la règle. Tous les champs présents doivent correspondre. */
  declencheur: {
    setup?: Setup;
    etiquette: string;
    symbole?: string;
    classe?: 'crypto' | 'forex' | 'metal';
    /** Plage horaire UTC, en heures pleines, bornes incluses. */
    heuresUtc?: [number, number];
  };
  preuves: {
    n: number;
    tauxReussitePct: number;
    esperanceR: number;
    lecons: string[];
  };
  statut: StatutRegle;
  promueLe: string;
  retrogradeeLe?: string;
  motifRetrogradation?: string;
  /** Trades pris malgré la règle, ou filtrés par elle, et leur R. Sert à la retester. */
  suivi: Array<{ tradeId: string; rRealise: number; filtre: boolean }>;
}

export interface Memoire {
  lecons: Lecon[];
  regles: Regle[];
}

/** Le contexte contre lequel une règle est évaluée. */
export interface ContexteAnalyse {
  setup: Setup;
  symbole: string;
  classe: 'crypto' | 'forex' | 'metal';
  heureUtc: number;
}
