/**
 * Combien risquer, et donc quelle taille.
 *
 * Deux choses différentes que le trading confond souvent :
 *
 *   - **Le risque** est un choix. Combien de pourcent du capital je consens à
 *     perdre si le stop est touché.
 *   - **La taille** est un calcul. Une fois le risque choisi et le stop placé
 *     sur le graphique, la quantité ne se décide plus, elle se déduit.
 *
 * L'ancienne version dérivait le stop de la volatilité annualisée, parce
 * qu'aucun humain ne regardait de graphique. Ici le stop vient de la structure
 * lue sur ta capture : un niveau, un creux, une mèche. C'est mieux, et ça
 * change le sens du calcul — la distance au stop est une donnée d'entrée, plus
 * une sortie.
 */

import { BORNES } from '../settings.js';
import { niveauConfiance } from '../settings.js';

export interface EntreesRisque {
  /** Qualité du setup lue par Claude, dans [0,1]. */
  qualite: number;
  /** Pertes consécutives en cours. */
  pertesConsecutives: number;
  /** Drawdown actuel depuis le plus haut du capital, en %. */
  drawdownPct: number;
  /** Rapport gain/risque du plan, sur la première cible. */
  ratio: number;
  /** Nombre de trades déjà mesurés sur ce setup. */
  echantillonSetup: number;
  /** Espérance mesurée de ce setup, en R par trade. Absente si non mesurée. */
  esperanceSetup?: number;
  /** Faux pour une paire peu liquide, où un stop serré se fait balayer pour rien. */
  liquide: boolean;
}

export interface DecisionRisque {
  /** Pourcentage du capital à risquer. Zéro si le setup ne vaut pas d'être pris. */
  risquePct: number;
  /** Ce qui a fait baisser le risque, dans l'ordre d'application. */
  facteurs: Array<{ nom: string; multiplicateur: number; detail: string }>;
}

/**
 * Le pourcentage de risque, décidé à partir de nombres.
 *
 * Le principe qui gouverne toute la fonction : **aucun facteur ne peut être
 * supérieur à 1**. La qualité du setup fixe un plafond, et tout le reste ne
 * fait que réduire. Il n'existe donc aucun chemin par lequel une série de
 * gains, une forte conviction ou un beau graphique augmentent la mise.
 *
 * C'est volontairement asymétrique. L'inflation de confiance après trois gains
 * est un mode de défaillance aussi banal que la vengeance après trois pertes,
 * et il coûte plus cher parce qu'il frappe avec une taille plus grosse.
 */
export function risqueRecommande(e: EntreesRisque): DecisionRisque {
  const facteurs: DecisionRisque['facteurs'] = [];
  const qualite = Math.max(0, Math.min(1, e.qualite));

  // La qualité fixe le plafond, entre 30 % et 100 % du maximum autorisé.
  let risque = BORNES.risqueMaxPct * (0.3 + 0.7 * qualite);
  facteurs.push({
    nom: 'qualite_setup',
    multiplicateur: 0.3 + 0.7 * qualite,
    detail: `qualité ${qualite.toFixed(2)} → départ à ${risque.toFixed(2)} % du capital`,
  });

  const appliquer = (nom: string, mult: number, detail: string) => {
    if (mult >= 1) return;
    risque *= mult;
    facteurs.push({ nom, multiplicateur: mult, detail });
  };

  if (e.esperanceSetup !== undefined && e.echantillonSetup >= 10 && e.esperanceSetup < 0) {
    appliquer(
      'esperance_negative',
      0.5,
      `ce setup a une espérance de ${e.esperanceSetup.toFixed(2)} R sur ${e.echantillonSetup} trades`,
    );
  }

  if (niveauConfiance(e.echantillonSetup) === 'indicatif') {
    appliquer(
      'echantillon_faible',
      0.75,
      `seulement ${e.echantillonSetup} trades mesurés sur ce setup, rien n'est encore prouvé`,
    );
  }

  if (e.pertesConsecutives >= BORNES.pertesAvantReduction) {
    appliquer(
      'pertes_consecutives',
      0.5,
      `${e.pertesConsecutives} pertes d'affilée : taille divisée par deux jusqu'à un gain`,
    );
  }

  if (e.drawdownPct >= 10) {
    appliquer(
      'drawdown',
      0.5,
      `drawdown de ${e.drawdownPct.toFixed(1)} % depuis le plus haut`,
    );
  }

  if (e.ratio < 2) {
    appliquer(
      'ratio_faible',
      0.8,
      `rapport gain/risque de ${e.ratio.toFixed(2)}, sous 2`,
    );
  }

  if (!e.liquide) {
    appliquer(
      'liquidite',
      0.5,
      'paire peu liquide : le stop peut être balayé par le spread seul',
    );
  }

  const plafonne = Math.min(risque, BORNES.risqueMaxPct);

  // Sous le minimum, le trade ne vaut pas ses frais : autant ne pas le prendre.
  if (plafonne < BORNES.risqueMinPct) {
    return {
      risquePct: 0,
      facteurs: [
        ...facteurs,
        {
          nom: 'sous_le_minimum',
          multiplicateur: 0,
          detail: `${plafonne.toFixed(2)} % est sous le plancher de ${BORNES.risqueMinPct} % — le trade ne vaut pas les frais`,
        },
      ],
    };
  }

  return { risquePct: Number(plafonne.toFixed(3)), facteurs };
}

export interface EntreesTaille {
  capital: number;
  risquePct: number;
  prixEntree: number;
  prixStop: number;
  /**
   * Combien vaut une unité de la devise de cotation dans ta devise de compte.
   *
   * Pour BTC/USD sur un compte en euros, c'est le taux USD→EUR. Laisse à 1 et
   * la taille est exprimée en devise de cotation : c'est juste, mais ce n'est
   * pas des euros, et le système doit le dire plutôt que de faire comme si.
   */
  tauxDeviseCompte?: number;
}

export interface Taille {
  /** Quantité en unités de l'actif de base. */
  quantite: number;
  /** Valeur de la position dans la devise du compte. */
  notionnel: number;
  /** Ce que coûte le stop s'il est touché, dans la devise du compte. */
  perteSiStop: number;
  /** Distance au stop, en % du prix d'entrée. */
  distanceStopPct: number;
  levier: number;
  /** Vrai si `tauxDeviseCompte` valait 1 et que la conversion est donc supposée. */
  conversionSupposee: boolean;
}

/**
 * La taille, déduite du risque et de la distance au stop.
 *
 * Rend `undefined` quand l'entrée et le stop sont au même prix : il n'y a
 * alors pas de risque défini, donc pas de taille calculable. Ce n'est pas un
 * cas d'erreur exotique — c'est ce qui arrive quand un stop est placé sur le
 * prix courant, et rendre une taille infinie serait pire que rendre rien.
 */
export function calculerTaille(e: EntreesTaille): Taille | undefined {
  const distance = Math.abs(e.prixEntree - e.prixStop);
  if (distance <= 0 || e.prixEntree <= 0 || e.capital <= 0 || e.risquePct <= 0) return undefined;

  const taux = e.tauxDeviseCompte ?? 1;
  const budget = e.capital * (e.risquePct / 100);
  const quantite = budget / (distance * taux);
  const notionnel = quantite * e.prixEntree * taux;

  return {
    quantite: Number(quantite.toPrecision(8)),
    notionnel: Number(notionnel.toFixed(2)),
    perteSiStop: Number(budget.toFixed(2)),
    distanceStopPct: Number(((distance / e.prixEntree) * 100).toFixed(3)),
    levier: Number((notionnel / e.capital).toFixed(2)),
    conversionSupposee: (e.tauxDeviseCompte ?? 1) === 1,
  };
}

/**
 * Le rapport gain/risque d'un plan.
 *
 * Compté sur la distance, pas sur les pourcentages : c'est le seul calcul qui
 * reste juste quand le trade est à la vente.
 */
export function ratioGainRisque(entree: number, stop: number, cible: number): number {
  const risque = Math.abs(entree - stop);
  if (risque <= 0) return 0;
  return Number((Math.abs(cible - entree) / risque).toFixed(2));
}

/**
 * Ce que les frais coûtent, exprimé en fraction du risque.
 *
 * Le chiffre qui manque à la plupart des journaux de trading. Sur un scalp de
 * 0,3 % avec 0,1 % de frais aller-retour, un tiers du gain part en frais et le
 * « R » affiché est une fiction. Le bilan s'en sert pour dire si une série
 * gagnante l'est encore une fois les frais payés.
 */
export function fraisEnR(notionnel: number, perteSiStop: number, fraisPct = BORNES.fraisParDefautPct): number {
  if (perteSiStop <= 0) return 0;
  return Number(((notionnel * (fraisPct / 100)) / perteSiStop).toFixed(3));
}
