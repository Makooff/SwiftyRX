/**
 * Ce que le journal permet de dire, et rien de plus.
 *
 * Chaque statistique sort accompagnée de son échantillon et de son étiquette
 * de confiance. Ce n'est pas de la décoration : « 67 % de réussite » sur trois
 * trades et « 67 % » sur quarante sont deux affirmations différentes, et
 * afficher le même nombre sans le nombre de trades revient à mentir par
 * omission.
 */

import { type NiveauConfiance, niveauConfiance } from '../settings.js';
import { SETUPS, type Setup } from '../risk/types.js';
import type { Entree } from './types.js';

export interface StatsSetup {
  setup: Setup;
  /** Trades pris et dénoués. Les « attendre » n'y sont pas. */
  n: number;
  gains: number;
  pertes: number;
  neutres: number;
  tauxReussitePct: number;
  /** Espérance en R par trade. C'est le seul chiffre qui décide de quoi que ce soit. */
  esperanceR: number;
  /** Espérance une fois les frais réellement payés retirés. */
  esperanceNetteR: number;
  gainMoyenR: number;
  perteMoyenneR: number;
  confiance: NiveauConfiance;
  /** Trades où l'exécution n'a pas suivi le plan. */
  executionsRatees: number;
  /** Trades perdus dont le stop était trop serré plutôt que l'analyse fausse. */
  stopsTropServes: number;
  /** Trades gagnants issus d'un mauvais processus : de la chance, pas une méthode. */
  gainsParChance: number;
}

export interface Bilan {
  /** Décisions enregistrées, « attendre » compris. */
  decisions: number;
  /** Trades effectivement pris et dénoués. */
  trades: number;
  attentes: number;
  refusMoteur: number;
  gains: number;
  pertes: number;
  tauxReussitePct: number;
  esperanceR: number;
  esperanceNetteR: number;
  /** Somme des R, l'équivalent d'une courbe de capital en unités de risque. */
  cumulR: number;
  fraisTotaux: number;
  /** Plus longue série de pertes consécutives observée. */
  pireSerie: number;
  parSetup: StatsSetup[];
}

function moyenne(valeurs: number[]): number {
  if (valeurs.length === 0) return 0;
  return valeurs.reduce((s, v) => s + v, 0) / valeurs.length;
}

const arrondi = (v: number, d = 2): number => Number(v.toFixed(d));

/** Les trades dénoués : ceux qui ont un résultat et qui ont réellement été pris. */
export function tradesDenoues(entrees: Entree[]): Entree[] {
  return entrees.filter((e) => e.resultat && e.resultat.issue !== 'non_pris');
}

export function statsParSetup(entrees: Entree[], setup: Setup): StatsSetup {
  const trades = tradesDenoues(entrees).filter((e) => e.setup === setup);
  const r = trades.map((e) => e.resultat!.rRealise);
  const gains = trades.filter((e) => e.resultat!.issue === 'gain');
  const pertes = trades.filter((e) => e.resultat!.issue === 'perte');
  const neutres = trades.filter((e) => e.resultat!.issue === 'neutre');

  // Les frais sont retirés en R, sinon une série de scalps « gagnants » reste
  // gagnante sur le papier alors qu'elle a coûté de l'argent.
  const fraisR = trades.map((e) => {
    const risque = Math.abs(e.dimension?.montantRisque ?? 0);
    return risque > 0 ? e.resultat!.frais / risque : 0;
  });

  return {
    setup,
    n: trades.length,
    gains: gains.length,
    pertes: pertes.length,
    neutres: neutres.length,
    tauxReussitePct: trades.length > 0 ? arrondi((gains.length / trades.length) * 100, 1) : 0,
    esperanceR: arrondi(moyenne(r)),
    esperanceNetteR: arrondi(moyenne(r) - moyenne(fraisR)),
    gainMoyenR: arrondi(moyenne(gains.map((e) => e.resultat!.rRealise))),
    perteMoyenneR: arrondi(moyenne(pertes.map((e) => e.resultat!.rRealise))),
    confiance: niveauConfiance(trades.length),
    executionsRatees: trades.filter((e) => !e.resultat!.analyse.executionConforme).length,
    stopsTropServes: trades.filter((e) => e.resultat!.analyse.stopTropServe).length,
    gainsParChance: gains.filter((e) => e.resultat!.analyse.processus === 'mauvais').length,
  };
}

/**
 * La pire série de pertes consécutives.
 *
 * Utile parce que c'est le nombre qui dit si le dimensionnement tient : une
 * série de six pertes à 2 % coûte 12 % du capital, et savoir qu'elle est déjà
 * arrivée vaut mieux que de le découvrir.
 */
export function pireSerie(entrees: Entree[]): number {
  let pire = 0;
  let courante = 0;
  for (const e of tradesDenoues(entrees)) {
    if (e.resultat!.issue === 'perte') {
      courante += 1;
      pire = Math.max(pire, courante);
    } else if (e.resultat!.issue === 'gain') {
      courante = 0;
    }
  }
  return pire;
}

export function bilan(entrees: Entree[]): Bilan {
  const trades = tradesDenoues(entrees);
  const r = trades.map((e) => e.resultat!.rRealise);
  const gains = trades.filter((e) => e.resultat!.issue === 'gain').length;
  const fraisTotaux = trades.reduce((s, e) => s + e.resultat!.frais, 0);
  const fraisR = trades.map((e) => {
    const risque = Math.abs(e.dimension?.montantRisque ?? 0);
    return risque > 0 ? e.resultat!.frais / risque : 0;
  });

  return {
    decisions: entrees.length,
    trades: trades.length,
    attentes: entrees.filter((e) => e.verdict === 'attendre').length,
    refusMoteur: entrees.filter((e) => e.moteur.refus.length > 0).length,
    gains,
    pertes: trades.filter((e) => e.resultat!.issue === 'perte').length,
    tauxReussitePct: trades.length > 0 ? arrondi((gains / trades.length) * 100, 1) : 0,
    esperanceR: arrondi(moyenne(r)),
    esperanceNetteR: arrondi(moyenne(r) - moyenne(fraisR)),
    cumulR: arrondi(r.reduce((s, v) => s + v, 0)),
    fraisTotaux: arrondi(fraisTotaux),
    pireSerie: pireSerie(entrees),
    parSetup: SETUPS.map((s) => statsParSetup(entrees, s)).filter((s) => s.n > 0),
  };
}

/**
 * Le prix de la prudence.
 *
 * Répond à la question que le biais du survivant rend invisible : les trades
 * qu'on a refusés auraient-ils gagné ? On ne peut pas le savoir sans que tu le
 * dises, alors cette fonction compte seulement les « attendre » et les refus
 * pour lesquels un résultat a été renseigné après coup. Le reste est marqué
 * comme inconnu au lieu d'être compté comme un bon choix.
 */
export function coutDeLaPrudence(entrees: Entree[]): {
  ecartes: number;
  suivis: number;
  auraientGagne: number;
  auraientPerdu: number;
  rManques: number;
} {
  const ecartes = entrees.filter((e) => e.verdict === 'attendre' || e.moteur.refus.length > 0);
  const suivis = ecartes.filter((e) => e.resultat);
  const gagnants = suivis.filter((e) => e.resultat!.rRealise > 0);

  return {
    ecartes: ecartes.length,
    suivis: suivis.length,
    auraientGagne: gagnants.length,
    auraientPerdu: suivis.filter((e) => e.resultat!.rRealise < 0).length,
    rManques: arrondi(suivis.reduce((s, e) => s + e.resultat!.rRealise, 0)),
  };
}
