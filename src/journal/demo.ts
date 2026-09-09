/**
 * Le jeu d'exemple du tableau de bord.
 *
 * Sert uniquement quand `journal/trades.jsonl` est vide. Un écran vide ne
 * montrerait pas à quoi sert l'outil, et la page marque ces chiffres comme
 * fabriqués plutôt que de les faire passer pour des trades réels.
 *
 * Le scénario est délibérément moyen : quatorze trades, une espérance
 * légèrement positive avant frais et presque nulle après, une série de trois
 * pertes, un setup rentable et un autre qui coûte. C'est à quoi ressemble un
 * vrai début de journal — pas à une courbe qui monte, qui donnerait une idée
 * fausse de ce que l'outil promet.
 */

import type { Setup } from '../risk/types.js';
import type { Decision, Entree, Issue } from './types.js';
import type { Memoire } from '../memory/types.js';
import { bilan } from './stats.js';
import type { DonneesTableau } from './html.js';

interface Modele {
  jour: string;
  symbole: string;
  uniteTemps: string;
  sens: 'achat' | 'vente';
  setup: Setup;
  qualite: number;
  entree: number;
  stop: number;
  cible: number;
  r: number;
  /** Faux quand le trade a été gagné sans que le processus soit bon. */
  processus?: 'bon' | 'mauvais';
  stopTropServe?: boolean;
  executionConforme?: boolean;
}

const SCENARIO: Modele[] = [
  { jour: '2026-08-11', symbole: 'BTC/USD', uniteTemps: '15m', sens: 'achat', setup: 'retest', qualite: 0.71, entree: 71200, stop: 70750, cible: 72100, r: 2.0 },
  { jour: '2026-08-12', symbole: 'EUR/USD', uniteTemps: '15m', sens: 'vente', setup: 'rejet_niveau', qualite: 0.64, entree: 1.0912, stop: 1.0938, cible: 1.0855, r: -1 },
  { jour: '2026-08-13', symbole: 'BTC/USD', uniteTemps: '1h', sens: 'achat', setup: 'continuation_tendance', qualite: 0.78, entree: 72400, stop: 71600, cible: 74000, r: 2.0 },
  { jour: '2026-08-14', symbole: 'EUR/USD', uniteTemps: '15m', sens: 'achat', setup: 'retest', qualite: 0.58, entree: 1.0868, stop: 1.0849, cible: 1.0905, r: -1, stopTropServe: true },
  { jour: '2026-08-15', symbole: 'XAU/USD', uniteTemps: '1h', sens: 'achat', setup: 'cassure', qualite: 0.69, entree: 2418, stop: 2404, cible: 2446, r: 1.4 },
  { jour: '2026-08-18', symbole: 'ETH/USD', uniteTemps: '15m', sens: 'achat', setup: 'liquidite', qualite: 0.74, entree: 3120, stop: 3078, cible: 3210, r: 2.1 },
  { jour: '2026-08-19', symbole: 'EUR/USD', uniteTemps: '15m', sens: 'achat', setup: 'retest', qualite: 0.55, entree: 1.0881, stop: 1.0862, cible: 1.0918, r: -1, stopTropServe: true },
  { jour: '2026-08-20', symbole: 'BTC/USD', uniteTemps: '15m', sens: 'vente', setup: 'contre_tendance', qualite: 0.44, entree: 73800, stop: 74350, cible: 72700, r: -1 },
  { jour: '2026-08-21', symbole: 'GBP/USD', uniteTemps: '1h', sens: 'vente', setup: 'divergence', qualite: 0.61, entree: 1.2745, stop: 1.2792, cible: 1.2652, r: -1 },
  { jour: '2026-08-22', symbole: 'BTC/USD', uniteTemps: '15m', sens: 'achat', setup: 'news', qualite: 0.52, entree: 72900, stop: 72300, cible: 74100, r: 1.9, processus: 'mauvais', executionConforme: false },
  { jour: '2026-08-25', symbole: 'ETH/USD', uniteTemps: '1h', sens: 'achat', setup: 'continuation_tendance', qualite: 0.76, entree: 3245, stop: 3186, cible: 3363, r: 2.0 },
  { jour: '2026-08-26', symbole: 'EUR/USD', uniteTemps: '15m', sens: 'achat', setup: 'retest', qualite: 0.57, entree: 1.0903, stop: 1.0884, cible: 1.0941, r: -1 },
  { jour: '2026-08-27', symbole: 'XAU/USD', uniteTemps: '15m', sens: 'vente', setup: 'retournement_range', qualite: 0.66, entree: 2461, stop: 2472, cible: 2438, r: -1 },
  { jour: '2026-08-28', symbole: 'BTC/USD', uniteTemps: '1h', sens: 'achat', setup: 'cassure', qualite: 0.80, entree: 74600, stop: 73700, cible: 76400, r: 2.0 },
];

/** Une décision « attendre », pour que le journal d'exemple en porte aussi. */
const ATTENTES: Array<{ jour: string; symbole: string; setup: Setup; prix: number; pourquoi: string }> = [
  { jour: '2026-08-19', symbole: 'BTC/USD', setup: 'retournement_range', prix: 73150, pourquoi: 'milieu de range, aucun bord à jouer' },
  { jour: '2026-08-26', symbole: 'GBP/USD', setup: 'cassure', prix: 1.2688, pourquoi: 'inflation britannique dans 20 minutes' },
];

const CAPITAL_DEPART = 1000;

function construire(): { entrees: Entree[]; capital: number; plusHaut: number; pertes: number } {
  const entrees: Entree[] = [];
  let capital = CAPITAL_DEPART;
  let plusHaut = CAPITAL_DEPART;
  let pertes = 0;
  let n = 0;

  for (const m of SCENARIO) {
    n += 1;
    const id = `T-${m.jour}-${String(n).padStart(3, '0')}`;
    const risquePct = 1;
    const montantRisque = Number((capital * (risquePct / 100)).toFixed(2));
    const distance = Math.abs(m.entree - m.stop);
    const quantite = Number((montantRisque / distance).toPrecision(6));
    const notionnel = Number((quantite * m.entree).toFixed(2));
    const frais = Number(((notionnel * 0.1) / 100).toFixed(2));
    const pnl = Number((m.r * montantRisque - frais).toFixed(2));

    const capitalAvant = capital;
    capital = Number((capital + pnl).toFixed(2));
    plusHaut = Math.max(plusHaut, capital);
    pertes = m.r < 0 ? pertes + 1 : 0;

    const issue: Issue = m.r > 0 ? 'gain' : 'perte';
    const ratio = Number((Math.abs(m.cible - m.entree) / distance).toFixed(2));

    const decision: Decision = {
      kind: 'decision',
      id,
      horodatage: `${m.jour}T09:30:00.000Z`,
      symbole: m.symbole,
      uniteTemps: m.uniteTemps,
      verdict: m.sens === 'achat' ? 'acheter' : 'vendre',
      sens: m.sens,
      setup: m.setup,
      qualite: m.qualite,
      prixLu: m.entree,
      sourcePrix: 'capture',
      plan: { entree: m.entree, stop: m.stop, cible1: m.cible, ratio },
      dimension: { risquePct, montantRisque, quantite, notionnel, levier: Number((notionnel / capitalAvant).toFixed(2)) },
      moteur: { verdict: 'reduit', refus: [], facteurs: [] },
      raisonnement: {
        contexte: 'exemple',
        declencheur: 'exemple',
        invalidation: 'exemple',
        contreArgument: 'exemple',
        nonVisible: ['tout : ce trade est fabriqué'],
      },
      veille: [],
      reglesAppliquees: [],
      capitalAvant,
    };

    entrees.push({
      ...decision,
      resultat: {
        kind: 'resultat',
        id,
        horodatage: `${m.jour}T14:00:00.000Z`,
        issue,
        prixSortie: m.r > 0 ? m.cible : m.stop,
        rRealise: m.r,
        pnl,
        frais,
        capitalApres: capital,
        motifSortie: m.r > 0 ? 'cible atteinte' : 'stop touché',
        analyse: {
          declencheurSurvenu: true,
          executionConforme: m.executionConforme ?? true,
          stopTropServe: m.stopTropServe ?? false,
          processus: m.processus ?? 'bon',
          leconEnUnePhrase: null,
        },
      },
    });
  }

  for (const [i, a] of ATTENTES.entries()) {
    entrees.push({
      kind: 'decision',
      id: `T-${a.jour}-9${i}`,
      horodatage: `${a.jour}T11:00:00.000Z`,
      symbole: a.symbole,
      uniteTemps: '15m',
      verdict: 'attendre',
      sens: null,
      setup: a.setup,
      qualite: 0.3,
      prixLu: a.prix,
      sourcePrix: 'capture',
      plan: null,
      dimension: null,
      moteur: { verdict: 'refuse', refus: ['ratio_minimum'], facteurs: [] },
      raisonnement: {
        contexte: 'exemple',
        declencheur: a.pourquoi,
        invalidation: 'sans objet',
        contreArgument: 'exemple',
        nonVisible: ['tout : cette décision est fabriquée'],
      },
      veille: [],
      reglesAppliquees: [],
      capitalAvant: capital,
    });
  }

  return { entrees, capital, plusHaut, pertes };
}

const LECONS_DEMO = [
  {
    id: 'L-001',
    horodatage: '2026-08-14T14:10:00.000Z',
    tradeId: 'T-2026-08-14-004',
    setup: 'retest' as Setup,
    sens: 'achat' as const,
    symbole: 'EUR/USD',
    etiquette: 'stop_sous_le_corps',
    texte: "sur EUR/USD en 15 minutes, un stop sous le corps de bougie se fait balayer là où un stop sous la mèche tient",
    rRealise: -1,
  },
  {
    id: 'L-002',
    horodatage: '2026-08-19T14:10:00.000Z',
    tradeId: 'T-2026-08-19-007',
    setup: 'retest' as Setup,
    sens: 'achat' as const,
    symbole: 'EUR/USD',
    etiquette: 'stop_sous_le_corps',
    texte: "encore un retest EUR/USD stoppé au tick près avant de repartir vers la cible sans moi",
    rRealise: -1,
  },
  {
    id: 'L-003',
    horodatage: '2026-08-26T14:10:00.000Z',
    tradeId: 'T-2026-08-26-012',
    setup: 'retest' as Setup,
    sens: 'achat' as const,
    symbole: 'EUR/USD',
    etiquette: 'stop_sous_le_corps',
    texte: "un stop à moins de 20 pips sur un retest EUR/USD ne survit pas au bruit de la séance",
    rRealise: -1,
  },
  {
    id: 'L-004',
    horodatage: '2026-08-22T15:00:00.000Z',
    tradeId: 'T-2026-08-22-010',
    setup: 'news' as Setup,
    sens: 'achat' as const,
    symbole: 'BTC/USD',
    etiquette: 'entree_avant_publication',
    texte: "entrer avant une publication macro a gagné cette fois, mais l'entrée était hors plan et le stop hors de portée",
    rRealise: 1.9,
  },
];

/** Le jeu complet, prêt à rendre. */
export function jeuDeDemonstration(): DonneesTableau {
  const { entrees, capital, plusHaut, pertes } = construire();

  const memoire: Memoire = {
    lecons: LECONS_DEMO,
    regles: [
      {
        id: 'R-01',
        enonce: "sur un retest EUR/USD en 15 minutes, placer le stop sous la mèche et non sous le corps",
        action: 'reduire',
        declencheur: { setup: 'retest', etiquette: 'stop_sous_le_corps', classe: 'forex' },
        preuves: { n: 3, tauxReussitePct: 0, esperanceR: -1, lecons: ['L-001', 'L-002', 'L-003'] },
        statut: 'active',
        promueLe: '2026-08-26T18:00:00.000Z',
        suivi: [
          { tradeId: 'T-2026-08-14-004', rRealise: -1, filtre: false },
          { tradeId: 'T-2026-08-19-007', rRealise: -1, filtre: false },
          { tradeId: 'T-2026-08-26-012', rRealise: -1, filtre: false },
        ],
      },
    ],
  };

  return {
    etat: {
      capital,
      devise: 'EUR',
      capitalDebutJour: capital,
      capitalDebutSemaine: Number((capital - 4.2).toFixed(2)),
      plusHaut,
      positions: [
        {
          symbole: 'ETH/USD',
          sens: 'achat',
          notionnel: 612.4,
          risqueOuvert: 10.3,
          groupeCorrele: 'crypto',
          expositionDollar: -1,
          ouverteLe: '2026-08-28T08:15:00.000Z',
        },
      ],
      tradesAujourdhui: 1,
      pertesConsecutives: pertes,
    },
    bilan: bilan(entrees),
    memoire,
    entrees,
    arrets: [],
    demonstration: true,
  };
}
