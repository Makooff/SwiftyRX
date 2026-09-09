/**
 * Une analyse, de la capture au verdict.
 *
 * L'ordre compte et ne change pas :
 *
 *  1. La mémoire et l'état du compte sont chargés **avant** l'appel au modèle,
 *     pour qu'il analyse en sachant ce qui a déjà été mesuré.
 *  2. Le modèle lit l'image et rend une lecture structurée.
 *  3. Le moteur de risque décide, à partir de nombres seulement. Il ne reçoit
 *     ni l'image ni le raisonnement.
 *  4. La décision est écrite au journal, y compris quand c'est « attendre » et
 *     y compris quand le moteur refuse.
 *
 * L'étape 4 est celle qu'on serait tenté de sauter, et c'est celle qui rend le
 * bilan honnête : sans les décisions qui n'ont produit aucun trade, le journal
 * ne garde que ce qu'on a tenté.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnalyseSchema, type AnalyseModele, type ReponseAnalyse } from './schema.js';
import { CONSIGNE, construireContexte } from './prompt.js';
import { MoteurRisque } from '../risk/engine.js';
import { groupeCorrele, expositionDollar, lirePaire } from '../risk/instrument.js';
import { Journal } from '../journal/journal.js';
import { Compte } from '../journal/state.js';
import { bilan, statsParSetup } from '../journal/stats.js';
import { chargerMemoire } from '../memory/store.js';
import { reglesApplicables } from '../memory/rules.js';
import { SETUPS, type Sens } from '../risk/types.js';

export const MODELE = 'claude-opus-5';

export interface DemandeAnalyse {
  /** L'image, en base64, sans le préfixe `data:`. */
  image: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Ce que le trader a écrit à côté de son image. */
  indice?: string;
  /** Taux de la devise de cotation vers la devise du compte. */
  taux?: number;
}

/** Le client, construit une fois. La clé vient de l'environnement. */
let client: Anthropic | undefined;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class CleManquante extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY n'est pas définie. Copie .env.exemple en .env et mets ta clé dedans, puis relance.",
    );
    this.name = 'CleManquante';
  }
}

/** Lit la capture et rend la lecture structurée du modèle. */
async function lireGraphique(
  demande: DemandeAnalyse,
  contexte: string,
): Promise<AnalyseModele> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new CleManquante();
  }

  const reponse = await anthropic().messages.parse({
    model: MODELE,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: zodOutputFormat(AnalyseSchema),
    },
    // La consigne ne bouge jamais : elle est mise en cache et le contexte,
    // qui change à chaque appel, arrive après elle dans le message.
    system: [{ type: 'text', text: CONSIGNE, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: demande.mediaType, data: demande.image } },
          { type: 'text', text: contexte },
        ],
      },
    ],
  });

  if (reponse.stop_reason === 'refusal') {
    throw new Error(
      `Le modèle a refusé d'analyser cette image (${reponse.stop_details?.category ?? 'sans catégorie'}).`,
    );
  }

  const lecture = reponse.parsed_output;
  if (!lecture) {
    throw new Error("Le modèle n'a pas rendu de lecture exploitable. Réessaie avec une capture plus nette.");
  }
  return lecture;
}

/** Contraint la lecture du modèle aux valeurs que le reste du système accepte. */
function assainir(lecture: AnalyseModele): AnalyseModele {
  return {
    ...lecture,
    qualite: Math.max(0, Math.min(1, lecture.qualite)),
    setup: SETUPS.includes(lecture.setup) ? lecture.setup : 'retournement_range',
    nonVisible: lecture.nonVisible.length > 0 ? lecture.nonVisible : ['non précisé par le modèle'],
    contreArgument: lecture.contreArgument.trim() || 'aucun contre-argument formulé',
  };
}

export async function analyser(demande: DemandeAnalyse): Promise<ReponseAnalyse> {
  const journal = new Journal();
  const compte = new Compte();
  const memoire = await chargerMemoire();

  const entrees = await journal.lireTout();
  const etat = await compte.charger();
  const global = bilan(entrees);
  const moteur = new MoteurRisque();
  const arrets = moteur.conditionsArret(etat);

  // --- 1 et 2 : la mémoire d'abord, puis la lecture ------------------------
  const contexte = construireContexte({
    etat,
    regles: memoire.regles.filter((r) => r.statut === 'active'),
    statsGlobales: {
      trades: global.trades,
      esperanceR: global.esperanceR,
      esperanceNetteR: global.esperanceNetteR,
    },
    statsParSetup: global.parSetup,
    arrets: arrets.map((a) => a.message),
    ...(demande.indice ? { indice: demande.indice } : {}),
  });

  const lecture = assainir(await lireGraphique(demande, contexte));
  const stats = statsParSetup(entrees, lecture.setup);

  const paire = lirePaire(lecture.paire);
  const reglesQuiSAppliquent = paire
    ? reglesApplicables(memoire, {
        setup: lecture.setup,
        symbole: paire.symbole,
        classe: paire.classe === 'inconnu' ? 'crypto' : paire.classe,
        heureUtc: new Date().getUTCHours(),
      })
    : [];

  const commun = {
    regles: reglesQuiSAppliquent.map((r) => ({ id: r.id, action: r.action, enonce: r.enonce })),
    stats: {
      n: stats.n,
      tauxReussitePct: stats.tauxReussitePct,
      esperanceR: stats.esperanceR,
      confiance: stats.confiance,
    },
    arrets: arrets.map((a) => ({ regle: a.regle, message: a.message })),
    devise: etat.devise,
    capital: etat.capital,
  };

  // --- Une lecture incomplète ne devient pas une décision -------------------
  // On enregistre quand même, pour que le journal garde la trace de la
  // question posée, mais sans plan ni taille.
  const sens: Sens | null =
    lecture.verdict === 'acheter' ? 'achat' : lecture.verdict === 'vendre' ? 'vente' : null;

  if (!sens || !paire || lecture.illisible.length > 0) {
    const id = await enregistrer({ journal, compte, lecture, paire: paire?.symbole ?? lecture.paire, etat, moteurResume: { verdict: 'non_evalue', refus: [], facteurs: [] }, plan: null, dimension: null, regles: reglesQuiSAppliquent.map((r) => r.id) });
    return { id, lecture, moteur: null, ...commun };
  }

  // --- 3 : le moteur, sur des nombres seulement ----------------------------
  const decision = moteur.evaluer(
    {
      symbole: paire.symbole,
      sens,
      setup: lecture.setup,
      qualite: lecture.qualite,
      prixEntree: lecture.entree,
      prixStop: lecture.stop,
      prixCible: lecture.cible1,
      ...(lecture.cible2 > 0 ? { prixCible2: lecture.cible2 } : {}),
      ...(demande.taux !== undefined ? { tauxDeviseCompte: demande.taux } : {}),
      echantillonSetup: stats.n,
      ...(stats.n > 0 ? { esperanceSetup: stats.esperanceR } : {}),
      reglesApprises: reglesQuiSAppliquent.map((r) => ({
        id: r.id,
        action: r.action,
        motif: r.enonce,
      })),
    },
    etat,
  );

  const refuse = decision.verdict === 'refuse';

  // --- 4 : le journal, refus compris ---------------------------------------
  const id = await enregistrer({
    journal,
    compte,
    lecture: refuse ? { ...lecture, verdict: 'attendre' } : lecture,
    paire: paire.symbole,
    etat,
    moteurResume: {
      verdict: decision.verdict,
      refus: decision.refus.map((r) => r.regle),
      facteurs: decision.facteursRisque,
    },
    plan: refuse
      ? null
      : {
          entree: lecture.entree,
          stop: lecture.stop,
          cible1: lecture.cible1,
          ...(lecture.cible2 > 0 ? { cible2: lecture.cible2 } : {}),
          ratio: decision.ratio,
          ...(decision.ratio2 !== undefined ? { ratio2: decision.ratio2 } : {}),
        },
    dimension: refuse
      ? null
      : {
          risquePct: decision.risquePct,
          montantRisque: decision.perteSiStop,
          quantite: decision.quantite,
          notionnel: decision.notionnel,
          levier: decision.levier,
        },
    regles: reglesQuiSAppliquent.map((r) => r.id),
  });

  if (!refuse) {
    await compte.ouvrirPosition({
      symbole: paire.symbole,
      sens,
      notionnel: decision.notionnel,
      risqueOuvert: decision.perteSiStop,
      groupeCorrele: groupeCorrele(paire),
      expositionDollar: expositionDollar(paire, sens),
      ouverteLe: new Date().toISOString(),
    });
  }

  return {
    id,
    lecture,
    moteur: {
      verdict: decision.verdict,
      risquePct: decision.risquePct,
      perteSiStop: decision.perteSiStop,
      quantite: decision.quantite,
      notionnel: decision.notionnel,
      levier: decision.levier,
      ratio: decision.ratio,
      ...(decision.ratio2 !== undefined ? { ratio2: decision.ratio2 } : {}),
      distanceStopPct: decision.distanceStopPct,
      fraisEnR: decision.fraisEnR,
      conversionSupposee: decision.conversionSupposee,
      refus: decision.refus,
      verifications: decision.verifications,
      facteurs: decision.facteursRisque,
    },
    ...commun,
  };
}

async function enregistrer(a: {
  journal: Journal;
  compte: Compte;
  lecture: AnalyseModele;
  paire: string;
  etat: { capital: number };
  moteurResume: { verdict: string; refus: string[]; facteurs: Array<{ nom: string; multiplicateur: number; detail: string }> };
  plan: import('../journal/types.js').Plan | null;
  dimension: import('../journal/types.js').Dimension | null;
  regles: string[];
}): Promise<string> {
  const id = await a.journal.prochainId();
  await a.journal.enregistrer({
    id,
    symbole: a.paire,
    uniteTemps: a.lecture.uniteTemps || 'non lu',
    verdict: a.lecture.verdict,
    sens: a.lecture.verdict === 'acheter' ? 'achat' : a.lecture.verdict === 'vendre' ? 'vente' : null,
    setup: a.lecture.setup,
    qualite: a.lecture.qualite,
    prixLu: a.lecture.prixLu,
    sourcePrix: 'capture',
    plan: a.plan,
    dimension: a.dimension,
    moteur: a.moteurResume,
    raisonnement: {
      contexte: a.lecture.contexte,
      declencheur: a.lecture.declencheur,
      invalidation: a.lecture.invalidation,
      contreArgument: a.lecture.contreArgument,
      nonVisible: a.lecture.nonVisible,
    },
    veille: [],
    reglesAppliquees: a.regles,
    capitalAvant: a.etat.capital,
  });
  return id;
}
