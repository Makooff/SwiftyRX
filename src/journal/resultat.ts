/**
 * Enregistrer ce qui s'est réellement passé.
 *
 * Partagé par l'application et par la ligne de commande, pour qu'il n'existe
 * qu'un seul endroit où le R se calcule et où le capital bouge. Deux
 * implémentations de ce calcul finiraient par diverger, et c'est le chiffre
 * sur lequel tout le reste repose.
 */

import { Journal } from './journal.js';
import { Compte } from './state.js';
import { ajouterLecon, leconRecevable } from '../memory/store.js';
import { BORNES } from '../settings.js';
import type { Analyse, Issue } from './types.js';

export interface SaisieResultat {
  id: string;
  issue: Issue;
  /** Prix de sortie réel. Sert à calculer le R ; absent, on retombe sur le stop. */
  prixSortie?: number;
  /** Force le R au lieu de le calculer. À n'utiliser que pour une sortie partielle. */
  rForce?: number;
  frais?: number;
  motifSortie?: string;
  analyse: Analyse;
  /** Mot-clé court, réutilisé à l'identique. Obligatoire dès qu'il y a une leçon. */
  etiquette?: string;
}

export interface ResultatEnregistre {
  id: string;
  rRealise: number;
  pnl: number;
  frais: number;
  capitalAvant: number;
  capitalApres: number;
  leconId?: string;
  /** Ce qui mérite d'être dit à l'utilisateur, au-delà des chiffres. */
  remarques: string[];
}

export class ResultatRefuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultatRefuse';
  }
}

export async function enregistrerResultat(
  saisie: SaisieResultat,
  outils: { journal?: Journal; compte?: Compte } = {},
): Promise<ResultatEnregistre> {
  const journal = outils.journal ?? new Journal();
  const compte = outils.compte ?? new Compte();

  const entrees = await journal.lireTout();
  const entree = entrees.find((e) => e.id === saisie.id);
  if (!entree) {
    throw new ResultatRefuse(
      `Aucune décision « ${saisie.id} » au journal. Les dernières sont : ${entrees.slice(-5).map((e) => e.id).join(', ') || 'aucune'}.`,
    );
  }

  const texteLecon = saisie.analyse.leconEnUnePhrase?.trim();
  if (texteLecon) {
    if (!saisie.etiquette?.trim()) {
      throw new ResultatRefuse(
        "Une leçon sans étiquette ne pourra jamais concorder avec une autre, donc ne produira jamais de règle. Donne un mot-clé court en snake_case, réutilisable : session_asiatique, volume_faible, stop_sous_la_meche.",
      );
    }
    const jugement = leconRecevable(texteLecon);
    if (!jugement.ok) {
      throw new ResultatRefuse(
        `Leçon refusée : ${jugement.motif}. Exemple de leçon recevable : « un retest en session asiatique sur les majeures n'a pas le volume pour tenir ».`,
      );
    }
  }

  /**
   * Le R réalisé, compté sur la distance au stop avec le signe du sens.
   *
   * Calculé et non saisi : un R tapé à la main est un R arrondi dans le sens
   * qui arrange. Le calcul marche identiquement à l'achat et à la vente, ce
   * qui n'est pas le cas d'un calcul en pourcentage.
   */
  const rRealise = (() => {
    if (saisie.rForce !== undefined) return saisie.rForce;
    if (saisie.issue === 'non_pris') return 0;
    if (!entree.plan || saisie.prixSortie === undefined) return saisie.issue === 'perte' ? -1 : 0;
    const risque = Math.abs(entree.plan.entree - entree.plan.stop);
    if (risque <= 0) return 0;
    const signe = entree.sens === 'vente' ? -1 : 1;
    return Number((((saisie.prixSortie - entree.plan.entree) * signe) / risque).toFixed(3));
  })();

  const montantRisque = entree.dimension?.montantRisque ?? 0;
  const frais =
    saisie.frais ??
    Number((((entree.dimension?.notionnel ?? 0) * BORNES.fraisParDefautPct) / 100).toFixed(2));
  const pnl =
    saisie.issue === 'non_pris' ? 0 : Number((rRealise * montantRisque - frais).toFixed(2));

  const etat = await compte.charger();
  const capitalAvant = etat.capital;
  const capitalApres =
    saisie.issue === 'non_pris' ? capitalAvant : Number((capitalAvant + pnl).toFixed(2));

  await journal.enregistrerResultat({
    id: saisie.id,
    issue: saisie.issue,
    prixSortie: saisie.prixSortie ?? null,
    rRealise,
    pnl,
    frais,
    capitalApres,
    motifSortie: saisie.motifSortie ?? '',
    analyse: saisie.analyse,
  });

  if (saisie.issue !== 'non_pris') {
    await compte.appliquerResultat({ pnl, perte: rRealise < 0, symbole: entree.symbole });
  }

  let leconId: string | undefined;
  if (texteLecon && saisie.etiquette) {
    const lecon = await ajouterLecon({
      horodatage: new Date().toISOString(),
      tradeId: saisie.id,
      setup: entree.setup,
      sens: entree.sens,
      symbole: entree.symbole,
      etiquette: saisie.etiquette,
      texte: texteLecon,
      rRealise,
    });
    leconId = lecon.id;
  }

  // Les deux cas qu'on ne voit pas si personne ne les nomme.
  const remarques: string[] = [];
  if (saisie.issue === 'gain' && saisie.analyse.processus === 'mauvais') {
    remarques.push(
      "Gagné avec un mauvais processus. Le résultat flatte la méthode : c'est le trade qu'on répète parce qu'il a marché, et celui qui coûtera cher.",
    );
  }
  if (saisie.issue === 'perte' && saisie.analyse.processus === 'bon') {
    remarques.push(
      "Perdu avec un bon processus. Il n'y a rien à corriger ici — ce trade était à prendre.",
    );
  }
  if (saisie.analyse.stopTropServe) {
    remarques.push(
      "Stop touché avant que le prix reparte dans le bon sens. C'est le placement du stop, pas l'analyse : les deux se corrigent de façon opposée.",
    );
  }
  if (!saisie.analyse.declencheurSurvenu) {
    remarques.push(
      "Le déclencheur prévu ne s'est pas produit. On est entré sur autre chose que le plan, donc ce résultat ne dit rien sur le plan.",
    );
  }

  return {
    id: saisie.id,
    rRealise,
    pnl,
    frais,
    capitalAvant,
    capitalApres,
    ...(leconId ? { leconId } : {}),
    remarques,
  };
}
