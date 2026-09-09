/**
 * Ce qu'on écrit, et pourquoi on l'écrit comme ça.
 *
 * Une règle gouverne ce fichier : **toute décision est enregistrée, y compris
 * celles qui n'ont produit aucun trade**. Les « ATTENDRE » et les refus du
 * moteur de risque occupent des lignes au même titre que les trades pris.
 *
 * Sans ça, le journal ne garde que ce qui a été tenté et flatte le système :
 * on ne saurait jamais si les trades refusés auraient gagné, ni si la
 * prudence coûte plus qu'elle ne rapporte. C'est du biais du survivant, et
 * c'est la façon la plus courante de croire qu'un système marche.
 */

import type { Setup, Sens } from '../risk/types.js';

export type Verdict = 'acheter' | 'vendre' | 'attendre';

/** Comment le prix est arrivé jusqu'ici. Jamais deviné, toujours dit. */
export type SourcePrix = 'capture' | 'saisie';

export interface Plan {
  entree: number;
  stop: number;
  cible1: number;
  cible2?: number;
  ratio: number;
  ratio2?: number;
}

export interface Dimension {
  risquePct: number;
  montantRisque: number;
  quantite: number;
  notionnel: number;
  levier: number;
}

export interface Raisonnement {
  /** Tendance et phase du marché sur l'unité de temps supérieure. */
  contexte: string;
  /** Ce qui justifie d'entrer maintenant plutôt que dans une heure. */
  declencheur: string;
  /** La condition qui tue le scénario avant même que le stop soit touché. */
  invalidation: string;
  /** Ce qui pourrait faire échouer ce trade, formulé avant de le prendre. */
  contreArgument: string;
  /** Ce que la capture ne montre pas et qui aurait compté. */
  nonVisible: string[];
}

export interface ElementVeille {
  titre: string;
  source: string;
  /** Date de publication, telle que la source l'affiche. */
  publieLe: string;
  impact: 'fort' | 'moyen' | 'faible';
}

export interface Decision {
  kind: 'decision';
  /** Identifiant lisible, `T-2026-09-09-001`. Sert de clé au résultat. */
  id: string;
  horodatage: string;
  symbole: string;
  uniteTemps: string;
  verdict: Verdict;
  sens: Sens | null;
  setup: Setup;
  qualite: number;
  prixLu: number;
  sourcePrix: SourcePrix;
  plan: Plan | null;
  dimension: Dimension | null;
  /** Le verdict du moteur de risque et ce qui l'a motivé. */
  moteur: {
    verdict: string;
    refus: string[];
    facteurs: Array<{ nom: string; multiplicateur: number; detail: string }>;
  };
  raisonnement: Raisonnement;
  veille: ElementVeille[];
  reglesAppliquees: string[];
  capitalAvant: number;
}

export type Issue =
  /** Le stop a été touché. */
  | 'perte'
  /** Une cible a été atteinte. */
  | 'gain'
  /** Sorti à l'équilibre, ou presque. */
  | 'neutre'
  /** Le trade n'a pas été pris : verdict « attendre », refus, ou choix de ta part. */
  | 'non_pris';

/**
 * La grille du pourquoi.
 *
 * Cinq questions, pas plus. Chacune sépare deux choses qu'on confond quand on
 * relit un trade à chaud, et c'est cette séparation qui produit une leçon
 * utilisable plutôt qu'un « j'aurais dû être patient ».
 */
export interface Analyse {
  /** 1. Le déclencheur prévu s'est-il réellement produit ? */
  declencheurSurvenu: boolean;
  /** 2. L'exécution a-t-elle suivi le plan : entrée, stop, sortie ? */
  executionConforme: boolean;
  /**
   * 3. Le stop a-t-il été touché avant que le prix reparte dans le bon sens ?
   *
   * Un stop balayé puis une cible atteinte sans nous, ce n'est pas une
   * mauvaise analyse : c'est un stop mal placé. Les deux erreurs se corrigent
   * de façon opposée et les confondre fait apprendre l'inverse.
   */
  stopTropServe: boolean;
  /**
   * 4. Bon processus, ou bon résultat ?
   *
   * Les quatre cases existent. Un bon trade peut perdre et un mauvais peut
   * gagner ; ne mesurer que le résultat revient à apprendre du bruit.
   */
  processus: 'bon' | 'mauvais';
  /**
   * 5. Qu'est-ce qui, connu avant l'entrée, aurait changé la décision ?
   *
   * C'est cette question qui produit la leçon. Une réponse vide est une
   * réponse valable : tous les trades n'enseignent pas quelque chose.
   */
  leconEnUnePhrase: string | null;
}

export interface Resultat {
  kind: 'resultat';
  id: string;
  horodatage: string;
  issue: Issue;
  prixSortie: number | null;
  /** Résultat en multiples du risque initial. −1 = le stop plein. */
  rRealise: number;
  /** Gain ou perte dans la devise du compte, frais déduits. */
  pnl: number;
  frais: number;
  capitalApres: number;
  motifSortie: string;
  analyse: Analyse;
}

export type Ligne = Decision | Resultat;

/** Une décision, avec son résultat replié dessus quand il est connu. */
export interface Entree extends Decision {
  resultat?: Resultat;
}

export function estResultat(ligne: Ligne): ligne is Resultat {
  return ligne.kind === 'resultat';
}
