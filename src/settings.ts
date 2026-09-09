/**
 * Les bornes du système.
 *
 * Tout ce qui décide *combien d'argent est en jeu* vit ici, en dur, et nulle
 * part ailleurs. C'est délibéré et c'est la seule contrainte que l'IA ne
 * choisit pas.
 *
 * La demande était : « c'est le Claude dans mon projet qui décide du risque en
 * fonction de son analyse ». Il le fait — il choisit librement le pourcentage
 * de risque de chaque trade, à l'intérieur de ces bornes, selon la qualité du
 * setup, l'espérance mesurée de ce setup et l'état du capital. Ce qu'il ne peut
 * pas faire, c'est relever le plafond ni lever un arrêt.
 *
 * Un système qui peut s'accorder plus de risque après une série de pertes
 * finit toujours par le faire, parce qu'il a un raisonnement pour chaque cas
 * particulier. Ces constantes n'écoutent pas les raisonnements.
 *
 * Elles ne sont pas sacrées pour autant : ce sont tes bornes, change-les ici.
 * Mais change-les à froid, pas pendant un trade.
 */

export interface Bornes {
  /** Capital de départ, en euros. */
  capitalInitial: number;
  devise: string;

  /** Risque minimum par trade, en % du capital. En dessous, ça ne vaut pas les frais. */
  risqueMinPct: number;
  /** Plafond dur du risque par trade, en % du capital. L'IA ne peut pas le dépasser. */
  risqueMaxPct: number;

  /** Part maximale du capital qu'une position peut représenter, en % (notionnel). */
  positionMaxPct: number;
  /** Exposition totale maximale, toutes positions confondues, en %. */
  expositionMaxPct: number;
  /** Exposition maximale sur un même groupe corrélé, en %. */
  correlationMaxPct: number;

  /** Risque cumulé maximum sur les positions ouvertes, en % du capital. */
  risqueOuvertMaxPct: number;
  /** Nombre maximum de positions ouvertes en même temps. */
  positionsMax: number;
  /** Nombre maximum de trades pris dans une journée. */
  tradesParJourMax: number;

  /** Perte du jour qui arrête la journée, en % du capital de début de journée. */
  arretJournalierPct: number;
  /** Perte de la semaine qui arrête la semaine, en % du capital de début de semaine. */
  arretHebdomadairePct: number;
  /** Drawdown depuis le plus haut qui impose un bilan avant de continuer, en %. */
  arretDrawdownPct: number;

  /** Pertes consécutives à partir desquelles la taille est divisée par deux. */
  pertesAvantReduction: number;
  /** Pertes consécutives à partir desquelles plus rien ne passe. */
  pertesAvantPause: number;
  /** Durée de la pause après cette série, en minutes. */
  pauseMinutes: number;

  /** Rapport gain/risque minimum pour qu'un trade soit recevable. */
  ratioMinimum: number;
  /** Levier maximum autorisé sur une position. */
  levierMax: number;
  /** Valeur notionnelle minimale d'un ordre, en euros. En dessous, les frais dominent. */
  notionnelMin: number;

  /** Frais aller-retour supposés, en % du notionnel, quand tu ne les donnes pas. */
  fraisParDefautPct: number;
}

/**
 * Le profil par défaut, pour 1 000 € de capital.
 *
 * `risqueMaxPct` à 2 est le point le plus important du fichier. Sur 1 000 €,
 * 2 % c'est 20 € : dix pertes d'affilée coûtent environ 18 % du capital, ce
 * dont on revient. À 5 %, les mêmes dix pertes en coûtent 40 %, ce dont on ne
 * revient pratiquement pas — il faut alors gagner 67 % pour revenir à zéro.
 * L'asymétrie entre perdre et récupérer est la raison d'être de ce plafond.
 */
export const BORNES: Bornes = {
  capitalInitial: 1000,
  devise: 'EUR',

  risqueMinPct: 0.25,
  risqueMaxPct: 2,

  positionMaxPct: 400,
  expositionMaxPct: 600,
  correlationMaxPct: 400,

  risqueOuvertMaxPct: 4,
  positionsMax: 3,
  tradesParJourMax: 6,

  arretJournalierPct: 4,
  arretHebdomadairePct: 8,
  arretDrawdownPct: 15,

  pertesAvantReduction: 2,
  pertesAvantPause: 3,
  pauseMinutes: 120,

  ratioMinimum: 1.5,
  levierMax: 5,
  notionnelMin: 20,

  fraisParDefautPct: 0.1,
};

/**
 * Seuils d'échantillon.
 *
 * Repris tels quels de l'ancien module de réglage automatique, qui avait
 * raison sur un point : sur trois trades on mesure du bruit, et un système
 * qui change ses seuils après trois trades apprend l'inverse de ce qu'il faut.
 */
export const ECHANTILLON = {
  /** En dessous, une statistique est affichée mais étiquetée « indicatif ». */
  indicatif: 10,
  /** En dessous, « émergent ». */
  emergent: 20,
  /** À partir d'ici, « établi ». */
  etabli: 20,
  /** Aucun réglage numérique n'est modifié en dessous de ce nombre de résultats. */
  minimumPourRegler: 30,
  /** Leçons concordantes nécessaires pour promouvoir une règle. */
  leconsPourPromouvoir: 3,
  /** Nombre maximum de règles actives avant arbitrage forcé au bilan. */
  reglesActivesMax: 12,
} as const;

export type NiveauConfiance = 'indicatif' | 'emergent' | 'etabli';

/** L'étiquette de confiance qui correspond à un échantillon de taille `n`. */
export function niveauConfiance(n: number): NiveauConfiance {
  if (n >= ECHANTILLON.etabli) return 'etabli';
  if (n >= ECHANTILLON.indicatif) return 'emergent';
  return 'indicatif';
}

export function libelleConfiance(n: number): string {
  const niveau = niveauConfiance(n);
  const mots: Record<NiveauConfiance, string> = {
    indicatif: 'indicatif',
    emergent: 'émergent',
    etabli: 'établi',
  };
  return `${mots[niveau]} (n=${n})`;
}
