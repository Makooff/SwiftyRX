/**
 * Mise en forme et échappement, sans dépendance au DOM.
 *
 * Séparé de `app.js` pour une raison précise : l'échappement est la seule
 * chose de l'interface qui doit être vraie sans qu'on la regarde, et une
 * fonction pure se teste dans Node sans monter de navigateur.
 */

/**
 * Neutralise le HTML d'une chaîne.
 *
 * Tout ce qui vient du journal, du modèle ou de l'utilisateur passe par ici
 * avant d'atteindre le DOM. Une leçon contient du texte libre, et un symbole
 * mal lu peut contenir n'importe quoi.
 */
export const txt = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const nb = (v, d = 2) =>
  Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Un prix se lit mieux sans ses zéros de queue : 1,0912 plutôt que 1,0912 0. */
export const prix = (v) => nb(v, 4).replace(/,?0+$/, '');

export const signe = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${nb(Math.abs(v), d)}`;

export const classe = (v) => (v > 0 ? 'gain' : v < 0 ? 'perte' : 'neutre');

export const LIBELLE_SETUP = {
  cassure: 'cassure de niveau',
  retest: 'retest de cassure',
  rejet_niveau: 'rejet sur niveau',
  retournement_range: 'retournement en extrémité de range',
  continuation_tendance: 'continuation de tendance',
  divergence: 'divergence de momentum',
  liquidite: 'prise de liquidité puis retournement',
  news: 'réaction à une actualité',
  contre_tendance: 'contre-tendance',
};

export const CONFIANCE = { indicatif: 'indicatif', emergent: 'émergent', etabli: 'établi' };
