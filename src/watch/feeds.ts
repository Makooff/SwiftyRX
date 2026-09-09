/**
 * Les flux suivis.
 *
 * Uniquement des points d'accès RSS ou Atom publiés par l'organisation
 * elle-même, et documentés publiquement. Pas d'aspiration de site, pas de
 * point d'accès non documenté, pas de miroir tiers.
 *
 * Une règle héritée de la version précédente du projet et gardée mot pour
 * mot : **aucune URL n'est inventée**. Un flux dont l'adresse n'a pas été
 * vérifiée n'est pas ajouté « au cas où » — il est absent, et son absence est
 * dite. Un flux qui a cessé de répondre est retiré avec la date, pas remplacé
 * par une adresse plausible.
 *
 * Le tri des sources est fait pour le forex et la crypto, ce qui change la
 * liste par rapport aux actions américaines : les banques centrales passent
 * devant tout le reste. Une décision de taux ou un changement de ton de la
 * BCE déplace l'EUR/USD plus sûrement que n'importe quelle actualité
 * d'entreprise.
 */

/** Ce qu'on accorde à une source avant de l'avoir mesurée. */
export type Niveau = 'officiel' | 'presse';

export interface Flux {
  id: string;
  nom: string;
  url: string;
  niveau: Niveau;
  /** Ce que ce flux sert à anticiper. */
  porte: 'taux' | 'macro' | 'marches' | 'crypto';
  juridiction: string;
  /** Devises que ce flux peut bouger. Sert à filtrer sur la paire analysée. */
  devises: string[];
  note?: string;
}

/**
 * Banques centrales et statistiques officielles.
 *
 * C'est le cœur du forex. Tout le reste est du commentaire.
 */
export const FLUX_OFFICIELS: Flux[] = [
  {
    id: 'bce_communiques',
    nom: 'Banque centrale européenne — Communiqués de presse',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    niveau: 'officiel',
    porte: 'taux',
    juridiction: 'UE',
    devises: ['EUR'],
    note: "La BCE publie ses décisions de politique monétaire dans ce flux. Réutilisation autorisée avec attribution.",
  },
  {
    id: 'fed_politique_monetaire',
    nom: 'Réserve fédérale — Communiqués de politique monétaire',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    niveau: 'officiel',
    porte: 'taux',
    juridiction: 'US',
    devises: ['USD'],
    note: "Le flux le plus important de la liste : le dollar est de l'autre côté de presque toutes les paires suivies ici.",
  },
  {
    id: 'fed_communiques',
    nom: 'Réserve fédérale — Tous les communiqués',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    niveau: 'officiel',
    porte: 'macro',
    juridiction: 'US',
    devises: ['USD'],
  },
  {
    id: 'bls_statistiques',
    nom: "Bureau of Labor Statistics — Publications",
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    niveau: 'officiel',
    porte: 'macro',
    juridiction: 'US',
    devises: ['USD'],
    note: "Inflation et emploi américains. Les deux publications qui font le plus bouger l'EUR/USD dans la minute.",
  },
];

/** Presse financière. Utile pour le contexte, jamais pour un prix. */
export const FLUX_PRESSE: Flux[] = [
  {
    id: 'cnbc_finance',
    nom: 'CNBC — Finance',
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
    niveau: 'presse',
    porte: 'marches',
    juridiction: 'US',
    devises: ['USD'],
  },
  {
    id: 'ft_marches',
    nom: 'Financial Times — Marchés',
    url: 'https://www.ft.com/markets?format=rss',
    niveau: 'presse',
    porte: 'marches',
    juridiction: 'UK',
    devises: ['GBP', 'EUR', 'USD'],
    note: 'Titres et résumés seulement ; les articles complets sont derrière un péage.',
  },
];

export const TOUS_LES_FLUX: Flux[] = [...FLUX_OFFICIELS, ...FLUX_PRESSE];

/**
 * Les flux susceptibles de bouger une paire donnée.
 *
 * Pour BTC/USD, ce sont les flux dollar : la crypto se trade contre le dollar
 * et réagit à la politique de la Fed comme un actif de risque. Il n'y a
 * volontairement aucun flux crypto « officiel » dans la liste — aucune source
 * n'a l'autorité d'une banque centrale sur ce marché, et prétendre le
 * contraire donnerait à un blog le poids d'un communiqué du FOMC.
 */
export function fluxPourPaire(base: string, cotation: string): Flux[] {
  const concernees = new Set([base, cotation]);
  return TOUS_LES_FLUX.filter((f) => f.devises.some((d) => concernees.has(d)));
}
