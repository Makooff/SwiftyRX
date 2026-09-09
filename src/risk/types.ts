/**
 * Le domaine du risque.
 *
 * Le moteur consomme une *proposition* et rend une *décision*. Il ne lit
 * jamais le raisonnement de Claude et ne voit jamais la capture d'écran : ses
 * entrées sont des nombres qu'il peut vérifier — des prix, des expositions,
 * des pertes, des compteurs, des horodatages.
 *
 * C'est la seule garantie sérieuse du système. Un modèle très confiant et un
 * modèle hésitant produisent le même objet ici, et sont traités pareil.
 */

export type Sens = 'achat' | 'vente';

/**
 * Les setups reconnus. Liste fermée, et c'est le point.
 *
 * Sans vocabulaire fixe, chaque trade est nommé un peu différemment et aucune
 * statistique ne s'agrège jamais : au bout de cinquante trades on a cinquante
 * catégories de un. Neuf entrées suffisent à décrire ce qui se prend en
 * intraday sur crypto et forex.
 */
export const SETUPS = [
  'cassure',
  'retest',
  'rejet_niveau',
  'retournement_range',
  'continuation_tendance',
  'divergence',
  'liquidite',
  'news',
  'contre_tendance',
] as const;

export type Setup = (typeof SETUPS)[number];

export function estSetup(valeur: string): valeur is Setup {
  return (SETUPS as readonly string[]).includes(valeur);
}

/** Libellés français des setups, pour l'affichage. */
export const LIBELLE_SETUP: Record<Setup, string> = {
  cassure: 'cassure de niveau',
  retest: 'retest de cassure',
  rejet_niveau: 'rejet sur niveau',
  retournement_range: 'retournement en extrémité de range',
  continuation_tendance: 'continuation de tendance',
  divergence: 'divergence de momentum',
  liquidite: 'prise de liquidité puis retournement',
  news: 'réaction à une actualité',
  contre_tendance: 'contre-tendance',
};

export interface PositionOuverte {
  symbole: string;
  sens: Sens;
  /** Valeur de la position dans la devise du compte. */
  notionnel: number;
  /** Ce que coûte son stop s'il est touché. */
  risqueOuvert: number;
  groupeCorrele: string;
  /** −1, 0 ou +1 : voir `expositionDollar`. */
  expositionDollar: -1 | 0 | 1;
  ouverteLe: string;
}

export interface EtatCompte {
  capital: number;
  devise: string;
  /** Capital au début de la journée de trading en cours. */
  capitalDebutJour: number;
  /** Capital au début de la semaine en cours. */
  capitalDebutSemaine: number;
  /** Plus haut niveau de capital jamais atteint, pour le drawdown. */
  plusHaut: number;
  positions: PositionOuverte[];
  tradesAujourdhui: number;
  /** Pertes consécutives, la plus récente en premier. */
  pertesConsecutives: number;
  dernierePerteLe?: string;
}

export type Verdict = 'approuve' | 'reduit' | 'refuse';

export interface Refus {
  /** Identifiant stable de la règle, par exemple `arret_journalier`. */
  regle: string;
  message: string;
  /** Vrai quand la règle arrête *tout* le trading, pas seulement cet ordre. */
  bloquant: boolean;
}

export interface Verification {
  regle: string;
  passe: boolean;
  detail: string;
}

export interface Proposition {
  symbole: string;
  sens: Sens;
  /** Qualité du setup lue par Claude, dans [0,1]. */
  qualite: number;
  setup: Setup;
  prixEntree: number;
  prixStop: number;
  /** Première cible. Sert au rapport gain/risque. */
  prixCible: number;
  /** Deuxième cible, facultative. */
  prixCible2?: number;
  /** Taux de la devise de cotation vers la devise du compte. */
  tauxDeviseCompte?: number;
  /** Trades déjà mesurés sur ce setup. */
  echantillonSetup?: number;
  /** Espérance mesurée de ce setup, en R. */
  esperanceSetup?: number;
  /** Identifiants des règles apprises qui demandent un refus ou une réduction. */
  reglesApprises?: Array<{ id: string; action: 'refuser' | 'reduire'; motif: string }>;
}

export interface DecisionComplete {
  verdict: Verdict;
  symbole: string;
  sens: Sens;
  setup: Setup;
  /** Risque retenu, en % du capital. Zéro si refusé. */
  risquePct: number;
  /** Ce que coûte le stop, dans la devise du compte. */
  perteSiStop: number;
  quantite: number;
  notionnel: number;
  levier: number;
  ratio: number;
  ratio2?: number;
  distanceStopPct: number;
  /** Coût des frais exprimé en fraction du risque. */
  fraisEnR: number;
  conversionSupposee: boolean;
  /** Toutes les vérifications, dans l'ordre, y compris après le premier refus. */
  verifications: Verification[];
  refus: Refus[];
  /** Ce qui a fait baisser le risque. */
  facteursRisque: Array<{ nom: string; multiplicateur: number; detail: string }>;
  decideLe: string;
}
