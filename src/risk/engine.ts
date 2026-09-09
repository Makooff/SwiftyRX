/**
 * Le moteur de risque.
 *
 * Indépendant du modèle par construction : il prend des nombres, applique des
 * règles dans un ordre fixe, et rend une décision. On ne peut pas discuter
 * avec lui.
 *
 * Deux propriétés héritées de la version précédente et gardées telles quelles,
 * parce qu'elles sont ce qui rend le journal lisible six semaines plus tard :
 *
 *  - **Toutes les vérifications tournent**, même après le premier refus. Le
 *    journal montre l'image complète et pas la première objection venue.
 *  - **Les conditions d'arrêt passent avant les conditions d'ordre**, pour que
 *    la raison la plus grave apparaisse en premier quand tu relis.
 */

import { BORNES } from '../settings.js';
import { type Clock, systemClock } from '../core/clock.js';
import { estLiquide, expositionDollar, groupeCorrele, lirePaire } from './instrument.js';
import { calculerTaille, fraisEnR, ratioGainRisque, risqueRecommande } from './sizing.js';
import type {
  DecisionComplete,
  EtatCompte,
  Proposition,
  Refus,
  Verification,
} from './types.js';

export interface OptionsMoteur {
  clock?: Clock;
  /** Frais aller-retour supposés, en % du notionnel. */
  fraisPct?: number;
}

export class MoteurRisque {
  private readonly clock: Clock;
  private readonly fraisPct: number;

  constructor(options: OptionsMoteur = {}) {
    this.clock = options.clock ?? systemClock;
    this.fraisPct = options.fraisPct ?? BORNES.fraisParDefautPct;
  }

  /**
   * Ce qui arrête tout le trading, indépendamment de l'ordre proposé.
   *
   * Exposé séparément pour qu'on puisse répondre « la journée est finie » sans
   * même analyser le graphique — c'est plus honnête et ça coûte moins cher que
   * de produire une analyse complète pour la refuser à la fin.
   */
  conditionsArret(etat: EtatCompte): Refus[] {
    const arrets: Refus[] = [];

    const perteJourPct =
      etat.capitalDebutJour > 0
        ? ((etat.capitalDebutJour - etat.capital) / etat.capitalDebutJour) * 100
        : 0;
    if (perteJourPct >= BORNES.arretJournalierPct) {
      arrets.push({
        regle: 'arret_journalier',
        message: `perte de ${perteJourPct.toFixed(2)} % aujourd'hui, la limite est ${BORNES.arretJournalierPct} % — journée terminée`,
        bloquant: true,
      });
    }

    const perteSemainePct =
      etat.capitalDebutSemaine > 0
        ? ((etat.capitalDebutSemaine - etat.capital) / etat.capitalDebutSemaine) * 100
        : 0;
    if (perteSemainePct >= BORNES.arretHebdomadairePct) {
      arrets.push({
        regle: 'arret_hebdomadaire',
        message: `perte de ${perteSemainePct.toFixed(2)} % cette semaine, la limite est ${BORNES.arretHebdomadairePct} % — semaine terminée, fais un bilan`,
        bloquant: true,
      });
    }

    const drawdown = etat.plusHaut > 0 ? ((etat.plusHaut - etat.capital) / etat.plusHaut) * 100 : 0;
    if (drawdown >= BORNES.arretDrawdownPct) {
      arrets.push({
        regle: 'drawdown_maximum',
        message: `drawdown de ${drawdown.toFixed(1)} % depuis le plus haut (${BORNES.arretDrawdownPct} % maximum) — bilan obligatoire avant de reprendre`,
        bloquant: true,
      });
    }

    if (etat.tradesAujourdhui >= BORNES.tradesParJourMax) {
      arrets.push({
        regle: 'trades_par_jour',
        message: `${etat.tradesAujourdhui} trades aujourd'hui, la limite est ${BORNES.tradesParJourMax}`,
        bloquant: true,
      });
    }

    // La pause après une série de pertes interrompt le schéma où on insiste
    // dans des conditions sur lesquelles on vient d'avoir tort trois fois.
    if (etat.pertesConsecutives >= BORNES.pertesAvantPause && etat.dernierePerteLe) {
      const minutes = (this.clock.nowMs() - Date.parse(etat.dernierePerteLe)) / 60_000;
      if (minutes < BORNES.pauseMinutes) {
        arrets.push({
          regle: 'pause_apres_pertes',
          message: `${etat.pertesConsecutives} pertes d'affilée — pause encore ${Math.ceil(BORNES.pauseMinutes - minutes)} minutes`,
          bloquant: true,
        });
      }
    }

    if (etat.positions.length >= BORNES.positionsMax) {
      arrets.push({
        regle: 'positions_simultanees',
        message: `${etat.positions.length} positions déjà ouvertes, la limite est ${BORNES.positionsMax}`,
        bloquant: true,
      });
    }

    return arrets;
  }

  evaluer(p: Proposition, etat: EtatCompte): DecisionComplete {
    const verifications: Verification[] = [];
    const refus: Refus[] = [];
    const decideLe = this.clock.now().toISOString();

    const verifier = (regle: string, passe: boolean, detail: string, bloquant = false) => {
      verifications.push({ regle, passe, detail });
      if (!passe) refus.push({ regle, message: detail, bloquant });
    };

    const vide = (facteurs: DecisionComplete['facteursRisque'] = []): DecisionComplete => ({
      verdict: 'refuse',
      symbole: p.symbole,
      sens: p.sens,
      setup: p.setup,
      risquePct: 0,
      perteSiStop: 0,
      quantite: 0,
      notionnel: 0,
      levier: 0,
      ratio: 0,
      distanceStopPct: 0,
      fraisEnR: 0,
      conversionSupposee: false,
      verifications,
      refus,
      facteursRisque: facteurs,
      decideLe,
    });

    // --- Arrêts d'abord --------------------------------------------------
    for (const arret of this.conditionsArret(etat)) {
      verifications.push({ regle: arret.regle, passe: false, detail: arret.message });
      refus.push(arret);
    }

    // --- L'instrument ----------------------------------------------------
    const paire = lirePaire(p.symbole);
    verifier(
      'paire_reconnue',
      paire !== undefined,
      paire
        ? `${paire.symbole} — ${paire.classe}${paire.majeure ? ', majeure' : ''}`
        : `${p.symbole} n'est ni une paire forex ni une paire crypto reconnue — vérifie le symbole plutôt que de deviner`,
    );
    if (!paire) return vide();

    // --- La cohérence du plan --------------------------------------------
    const sensStopCorrect =
      p.sens === 'achat' ? p.prixStop < p.prixEntree : p.prixStop > p.prixEntree;
    verifier(
      'stop_du_bon_cote',
      sensStopCorrect,
      sensStopCorrect
        ? `stop à ${p.prixStop}, du bon côté d'une ${p.sens === 'achat' ? 'position acheteuse' : 'position vendeuse'}`
        : `stop à ${p.prixStop} pour une ${p.sens === 'achat' ? 'position acheteuse' : 'position vendeuse'} entrée à ${p.prixEntree} : le plan est incohérent`,
    );

    const sensCibleCorrect =
      p.sens === 'achat' ? p.prixCible > p.prixEntree : p.prixCible < p.prixEntree;
    verifier(
      'cible_du_bon_cote',
      sensCibleCorrect,
      sensCibleCorrect ? `cible à ${p.prixCible}` : `cible à ${p.prixCible} du mauvais côté de l'entrée`,
    );

    verifier(
      'prix_valides',
      p.prixEntree > 0 && p.prixStop > 0 && p.prixCible > 0,
      `entrée ${p.prixEntree}, stop ${p.prixStop}, cible ${p.prixCible}`,
    );

    if (refus.length > 0) return vide();

    const ratio = ratioGainRisque(p.prixEntree, p.prixStop, p.prixCible);
    verifier(
      'ratio_minimum',
      ratio >= BORNES.ratioMinimum,
      `rapport gain/risque de ${ratio} (minimum ${BORNES.ratioMinimum})`,
    );

    // --- Les règles apprises ---------------------------------------------
    // Elles ne peuvent que refuser ou réduire. Aucune règle apprise ne peut
    // autoriser un trade que les bornes refusent, ni augmenter la taille.
    let facteurRegles = 1;
    for (const regle of p.reglesApprises ?? []) {
      if (regle.action === 'refuser') {
        verifier(`regle_${regle.id}`, false, `${regle.id} : ${regle.motif}`);
      } else {
        facteurRegles *= 0.5;
        verifications.push({
          regle: `regle_${regle.id}`,
          passe: true,
          detail: `${regle.id} : ${regle.motif} — taille réduite de moitié`,
        });
      }
    }

    // --- Le risque --------------------------------------------------------
    const drawdownPct = etat.plusHaut > 0 ? ((etat.plusHaut - etat.capital) / etat.plusHaut) * 100 : 0;
    const recommande = risqueRecommande({
      qualite: p.qualite,
      pertesConsecutives: etat.pertesConsecutives,
      drawdownPct,
      ratio,
      echantillonSetup: p.echantillonSetup ?? 0,
      ...(p.esperanceSetup !== undefined ? { esperanceSetup: p.esperanceSetup } : {}),
      liquide: estLiquide(paire),
    });

    const facteurs = [...recommande.facteurs];
    let risquePct = recommande.risquePct * facteurRegles;
    if (facteurRegles < 1) {
      facteurs.push({
        nom: 'regles_apprises',
        multiplicateur: facteurRegles,
        detail: 'une ou plusieurs règles apprises demandent une réduction',
      });
    }

    verifier(
      'risque_exploitable',
      risquePct >= BORNES.risqueMinPct,
      risquePct >= BORNES.risqueMinPct
        ? `${risquePct.toFixed(2)} % du capital`
        : `le risque calculé tombe à ${risquePct.toFixed(2)} %, sous le plancher de ${BORNES.risqueMinPct} % — ce trade ne vaut pas ses frais`,
    );

    if (refus.length > 0) return vide(facteurs);

    // --- La taille --------------------------------------------------------
    const taille = calculerTaille({
      capital: etat.capital,
      risquePct,
      prixEntree: p.prixEntree,
      prixStop: p.prixStop,
      ...(p.tauxDeviseCompte !== undefined ? { tauxDeviseCompte: p.tauxDeviseCompte } : {}),
    });
    verifier(
      'taille_calculable',
      taille !== undefined,
      taille ? `${taille.quantite} unités` : 'entrée et stop au même prix : aucune taille calculable',
    );
    if (!taille) return vide(facteurs);

    verifier(
      'notionnel_minimum',
      taille.notionnel >= BORNES.notionnelMin,
      `position de ${taille.notionnel} ${etat.devise} (minimum ${BORNES.notionnelMin} — en dessous, les frais dominent)`,
    );

    verifier(
      'levier_maximum',
      taille.levier <= BORNES.levierMax,
      `levier ${taille.levier} (maximum ${BORNES.levierMax})`,
    );

    verifier(
      'position_maximum',
      (taille.notionnel / etat.capital) * 100 <= BORNES.positionMaxPct,
      `la position pèse ${((taille.notionnel / etat.capital) * 100).toFixed(0)} % du capital (maximum ${BORNES.positionMaxPct} %)`,
    );

    // --- Le risque déjà engagé --------------------------------------------
    const risqueOuvert = etat.positions.reduce((s, pos) => s + pos.risqueOuvert, 0);
    const risqueTotalPct = ((risqueOuvert + taille.perteSiStop) / etat.capital) * 100;
    verifier(
      'risque_cumule',
      risqueTotalPct <= BORNES.risqueOuvertMaxPct,
      `risque total engagé ${risqueTotalPct.toFixed(2)} % (maximum ${BORNES.risqueOuvertMaxPct} %)`,
    );

    const exposition = etat.positions.reduce((s, pos) => s + pos.notionnel, 0);
    verifier(
      'exposition_totale',
      ((exposition + taille.notionnel) / etat.capital) * 100 <= BORNES.expositionMaxPct,
      `exposition totale ${(((exposition + taille.notionnel) / etat.capital) * 100).toFixed(0)} % (maximum ${BORNES.expositionMaxPct} %)`,
    );

    // --- La corrélation ---------------------------------------------------
    const groupe = groupeCorrele(paire);
    const memeGroupe = etat.positions
      .filter((pos) => pos.groupeCorrele === groupe)
      .reduce((s, pos) => s + pos.notionnel, 0);
    verifier(
      'exposition_correlee',
      ((memeGroupe + taille.notionnel) / etat.capital) * 100 <= BORNES.correlationMaxPct,
      `exposition « ${groupe} » à ${(((memeGroupe + taille.notionnel) / etat.capital) * 100).toFixed(0)} % (maximum ${BORNES.correlationMaxPct} %)`,
    );

    // Le dollar est le facteur commun de presque tout ce qui se trade ici.
    // Trois paires différentes peuvent être le même pari sur le dollar, et
    // compter les noms plutôt que les expositions le manquerait.
    const dollarCeTrade = expositionDollar(paire, p.sens);
    const dollarOuvert = etat.positions.reduce((s, pos) => s + pos.expositionDollar * pos.notionnel, 0);
    const dollarProjete = dollarOuvert + dollarCeTrade * taille.notionnel;
    const dollarPct = Math.abs(dollarProjete / etat.capital) * 100;
    verifier(
      'exposition_dollar',
      dollarPct <= BORNES.correlationMaxPct,
      dollarCeTrade === 0
        ? 'la paire ne porte pas de dollar'
        : `exposition nette au dollar ${dollarProjete > 0 ? 'longue' : 'courte'} de ${dollarPct.toFixed(0)} % du capital (maximum ${BORNES.correlationMaxPct} %)`,
    );

    if (refus.length > 0) return vide(facteurs);

    const frais = fraisEnR(taille.notionnel, taille.perteSiStop, this.fraisPct);
    if (frais > 0.15) {
      verifications.push({
        regle: 'poids_des_frais',
        passe: true,
        detail: `les frais représentent ${(frais * 100).toFixed(0)} % du risque — le R affiché sera nettement optimiste`,
      });
    }

    risquePct = Number(risquePct.toFixed(3));

    return {
      verdict: facteurRegles < 1 || recommande.risquePct < BORNES.risqueMaxPct ? 'reduit' : 'approuve',
      symbole: paire.symbole,
      sens: p.sens,
      setup: p.setup,
      risquePct,
      perteSiStop: taille.perteSiStop,
      quantite: taille.quantite,
      notionnel: taille.notionnel,
      levier: taille.levier,
      ratio,
      ...(p.prixCible2 !== undefined
        ? { ratio2: ratioGainRisque(p.prixEntree, p.prixStop, p.prixCible2) }
        : {}),
      distanceStopPct: taille.distanceStopPct,
      fraisEnR: frais,
      conversionSupposee: taille.conversionSupposee,
      verifications,
      refus: [],
      facteursRisque: facteurs,
      decideLe,
    };
  }
}
