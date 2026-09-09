/**
 * Promotion, application, rétrogradation.
 *
 * Le cycle de vie complet d'une règle apprise. Trois leçons concordantes la
 * font naître, elle filtre les analyses suivantes, et elle meurt quand les
 * faits cessent de lui donner raison.
 *
 * Ce dernier point est le plus important et le plus souvent oublié : un
 * système qui accumule des règles sans jamais en retirer finit par ne plus
 * rien laisser passer, et il aura l'air d'avoir appris quelque chose alors
 * qu'il aura seulement appris à refuser.
 */

import { ECHANTILLON } from '../settings.js';
import type { Entree } from '../journal/types.js';
import type { ContexteAnalyse, Lecon, Memoire, Regle } from './types.js';

/** Vrai si la règle s'applique au contexte donné. */
export function sApplique(regle: Regle, contexte: ContexteAnalyse): boolean {
  if (regle.statut !== 'active') return false;
  const d = regle.declencheur;
  if (d.setup && d.setup !== contexte.setup) return false;
  if (d.symbole && d.symbole !== contexte.symbole) return false;
  if (d.classe && d.classe !== contexte.classe) return false;
  if (d.heuresUtc) {
    const [debut, fin] = d.heuresUtc;
    const dedans =
      debut <= fin
        ? contexte.heureUtc >= debut && contexte.heureUtc <= fin
        : contexte.heureUtc >= debut || contexte.heureUtc <= fin;
    if (!dedans) return false;
  }
  return true;
}

export function reglesApplicables(memoire: Memoire, contexte: ContexteAnalyse): Regle[] {
  return memoire.regles.filter((r) => sApplique(r, contexte));
}

export interface CandidatPromotion {
  etiquette: string;
  setup: Lecon['setup'];
  lecons: Lecon[];
  esperanceR: number;
  /** Proposition d'action, à confirmer au bilan. */
  action: 'refuser' | 'reduire';
}

/**
 * Les groupes de leçons prêts à devenir des règles.
 *
 * Concordance = même setup **et** même étiquette **et** même sens du résultat.
 * Trois leçons qui disent « le retest en session asiatique ne tient pas » et
 * qui viennent toutes les trois de trades perdants concordent. Trois leçons
 * sur le même setup mais dont l'une vient d'un gain ne concordent pas : le
 * schéma n'est pas établi, il est contredit.
 */
export function candidatsPromotion(memoire: Memoire): CandidatPromotion[] {
  const dejaCouvertes = new Set(
    memoire.regles.map((r) => `${r.declencheur.setup ?? '*'}|${r.declencheur.etiquette}`),
  );

  const groupes = new Map<string, Lecon[]>();
  for (const lecon of memoire.lecons) {
    const cle = `${lecon.setup}|${lecon.etiquette}`;
    groupes.set(cle, [...(groupes.get(cle) ?? []), lecon]);
  }

  const candidats: CandidatPromotion[] = [];
  for (const [cle, lecons] of groupes) {
    if (dejaCouvertes.has(cle)) continue;
    if (lecons.length < ECHANTILLON.leconsPourPromouvoir) continue;

    // Toutes les leçons doivent pencher du même côté.
    const negatives = lecons.filter((l) => l.rRealise < 0).length;
    if (negatives !== lecons.length) continue;

    const esperanceR =
      lecons.reduce((s, l) => s + l.rRealise, 0) / lecons.length;

    candidats.push({
      etiquette: lecons[0]!.etiquette,
      setup: lecons[0]!.setup,
      lecons,
      esperanceR: Number(esperanceR.toFixed(2)),
      // Une perte moyenne franche justifie un refus ; une perte modérée
      // justifie seulement de réduire la taille.
      action: esperanceR <= -0.7 ? 'refuser' : 'reduire',
    });
  }

  return candidats;
}

export function promouvoir(
  candidat: CandidatPromotion,
  memoire: Memoire,
  maintenant: Date,
): Regle {
  const numero = memoire.regles.length + 1;
  const pertes = candidat.lecons.length;

  return {
    id: `R-${String(numero).padStart(2, '0')}`,
    enonce: candidat.lecons[0]!.texte,
    action: candidat.action,
    declencheur: { setup: candidat.setup, etiquette: candidat.etiquette },
    preuves: {
      n: pertes,
      tauxReussitePct: 0,
      esperanceR: candidat.esperanceR,
      lecons: candidat.lecons.map((l) => l.id),
    },
    statut: 'active',
    promueLe: maintenant.toISOString(),
    suivi: candidat.lecons.map((l) => ({ tradeId: l.tradeId, rRealise: l.rRealise, filtre: false })),
  };
}

export interface Retrogradation {
  regle: Regle;
  motif: string;
}

/**
 * Les règles que les faits ne soutiennent plus.
 *
 * Deux motifs, et ils ne se ressemblent pas.
 *
 *  - **La règle a eu tort.** Trois trades qu'elle aurait filtrés ont gagné.
 *    Elle coûte de l'argent en refusant de bons trades, et c'est un coût
 *    invisible si on ne le mesure pas exprès.
 *  - **La règle a cessé d'avoir raison.** Sur un échantillon devenu suffisant,
 *    l'espérance du schéma qu'elle interdit est repassée positive. C'est le
 *    cas d'une règle vraie en marché en tendance appliquée à un range, ou
 *    l'inverse : les régimes changent et les règles apprises dans l'un ne
 *    valent pas dans l'autre.
 */
export function candidatsRetrogradation(memoire: Memoire): Retrogradation[] {
  const sorties: Retrogradation[] = [];

  for (const regle of memoire.regles) {
    if (regle.statut !== 'active') continue;

    const filtresGagnants = regle.suivi.filter((s) => s.filtre && s.rRealise > 0);
    if (filtresGagnants.length >= 3) {
      sorties.push({
        regle,
        motif: `${filtresGagnants.length} trades écartés par cette règle auraient gagné — elle coûte plus qu'elle ne protège`,
      });
      continue;
    }

    if (regle.suivi.length >= ECHANTILLON.etabli) {
      const esperance = regle.suivi.reduce((s, x) => s + x.rRealise, 0) / regle.suivi.length;
      if (esperance > 0) {
        sorties.push({
          regle,
          motif: `sur ${regle.suivi.length} observations l'espérance est repassée à ${esperance.toFixed(2)} R — le régime a changé`,
        });
      }
    }
  }

  return sorties;
}

export function retrograder(regle: Regle, motif: string, maintenant: Date): Regle {
  return {
    ...regle,
    statut: 'retrogradee',
    retrogradeeLe: maintenant.toISOString(),
    motifRetrogradation: motif,
  };
}

/**
 * Met à jour le suivi des règles avec un trade dénoué.
 *
 * `filtre` distingue les deux cas dont dépend toute la rétrogradation : le
 * trade a-t-il été écarté *à cause* de cette règle, ou pris malgré elle ? Sans
 * cette distinction on ne peut pas savoir si une règle protège ou si elle
 * coûte.
 */
export function suivreRegles(memoire: Memoire, entree: Entree, contexte: ContexteAnalyse): Memoire {
  if (!entree.resultat) return memoire;
  const rRealise = entree.resultat.rRealise;
  const filtre = entree.verdict === 'attendre' || entree.moteur.refus.length > 0;

  return {
    ...memoire,
    regles: memoire.regles.map((regle) => {
      if (!sApplique(regle, contexte)) return regle;
      if (regle.suivi.some((s) => s.tradeId === entree.id)) return regle;
      return { ...regle, suivi: [...regle.suivi, { tradeId: entree.id, rRealise, filtre }] };
    }),
  };
}

/**
 * Le nombre de règles actives est-il devenu ingérable ?
 *
 * Douze règles est déjà beaucoup : au-delà, presque toute configuration en
 * déclenche une et le système n'analyse plus, il refuse. Le bilan force alors
 * un arbitrage plutôt que d'en ajouter une treizième en silence.
 */
export function tropDeRegles(memoire: Memoire): boolean {
  return memoire.regles.filter((r) => r.statut === 'active').length >= ECHANTILLON.reglesActivesMax;
}
