/**
 * Ce que le modèle a le droit de rendre après avoir regardé une capture.
 *
 * Le schéma est appliqué par l'API : la réponse est validée avant d'arriver
 * ici, donc pas de texte libre à analyser à la main ni de champ manquant à
 * gérer en silence.
 *
 * Remarque sur ce qui **n'est pas** dans ce schéma : le pourcentage de risque
 * et la taille de position. Le modèle rend une note de qualité et des prix ;
 * le moteur de risque fait le reste avec des nombres. Laisser le modèle
 * proposer sa propre mise reviendrait à lui laisser lever ses garde-fous un
 * jour où il est convaincu.
 */

import { z } from 'zod';
import { SETUPS } from '../risk/types.js';

export const AnalyseSchema = z.object({
  /** La paire telle qu'elle est écrite à l'écran. Vide si illisible. */
  paire: z.string(),
  /** L'unité de temps lue à l'écran : « 15m », « 1h », « 4h ». Vide si illisible. */
  uniteTemps: z.string(),
  /** Le prix courant lu à l'écran. Zéro si illisible. */
  prixLu: z.number(),
  /**
   * Ce qui n'a pas pu être lu sur l'image.
   *
   * Non vide veut dire qu'il faut poser la question plutôt que de décider.
   * Une supposition sur le prix fausse la taille de position, donc le risque
   * réel : c'est la seule erreur du système qui coûte de l'argent en silence.
   */
  illisible: z.array(z.string()),

  verdict: z.enum(['acheter', 'vendre', 'attendre']),
  setup: z.enum(SETUPS),
  /** Qualité du setup, entre 0 et 1. La seule entrée subjective du calcul. */
  qualite: z.number(),

  /** Prix du plan. Tous à zéro quand le verdict est « attendre ». */
  entree: z.number(),
  stop: z.number(),
  cible1: z.number(),
  /** Deuxième cible. Zéro s'il n'y en a pas. */
  cible2: z.number(),

  /** Tendance et phase sur l'unité de temps supérieure. */
  contexte: z.string(),
  /** Ce qui justifie d'entrer maintenant plutôt que dans une heure. */
  declencheur: z.string(),
  /** La condition qui tue le scénario avant même que le stop soit touché. */
  invalidation: z.string(),
  /** Ce qui pourrait faire échouer ce trade, formulé avant de le prendre. */
  contreArgument: z.string(),
  /** Ce que la capture ne montre pas et qui aurait compté. */
  nonVisible: z.array(z.string()),
});

export type AnalyseModele = z.infer<typeof AnalyseSchema>;

/**
 * Ce que le serveur rend au navigateur.
 *
 * La lecture du modèle et la décision du moteur restent séparées jusqu'au
 * bout, y compris dans la réponse : on doit pouvoir lire le journal six
 * semaines plus tard et distinguer ce que le modèle a vu de ce que le code a
 * décidé.
 */
export interface ReponseAnalyse {
  id: string | null;
  lecture: AnalyseModele;
  moteur: {
    verdict: string;
    risquePct: number;
    perteSiStop: number;
    quantite: number;
    notionnel: number;
    levier: number;
    ratio: number;
    ratio2?: number;
    distanceStopPct: number;
    fraisEnR: number;
    conversionSupposee: boolean;
    refus: Array<{ regle: string; message: string; bloquant: boolean }>;
    verifications: Array<{ regle: string; passe: boolean; detail: string }>;
    facteurs: Array<{ nom: string; multiplicateur: number; detail: string }>;
  } | null;
  /** Les règles apprises qui se sont appliquées. */
  regles: Array<{ id: string; action: string; enonce: string }>;
  /** Statistiques mesurées sur ce setup, avec leur échantillon. */
  stats: { n: number; tauxReussitePct: number; esperanceR: number; confiance: string };
  /** Ce qui arrête tout le trading, s'il y a lieu. */
  arrets: Array<{ regle: string; message: string }>;
  devise: string;
  capital: number;
}
