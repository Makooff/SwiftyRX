import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerServeur } from '../src/server/server.js';
import { enregistrerResultat, ResultatRefuse } from '../src/journal/resultat.js';
import { Journal } from '../src/journal/journal.js';
import { Compte } from '../src/journal/state.js';
import type { Decision } from '../src/journal/types.js';
// @ts-expect-error — module JavaScript du navigateur, sans déclaration de types.
import { classe, nb, prix, signe, txt } from '../src/web/format.js';

/**
 * Le serveur lit le journal depuis des chemins relatifs au dossier courant.
 * Chaque test travaille donc dans un dossier temporaire, et l'application ne
 * touche jamais aux vraies données pendant les tests.
 */
let racine: string;
let precedent: string;
let fermer: () => Promise<void>;
let base: string;

const decision: Omit<Decision, 'kind' | 'horodatage'> = {
  id: 'T-1',
  symbole: 'BTC/USD',
  uniteTemps: '15m',
  verdict: 'acheter',
  sens: 'achat',
  setup: 'retest',
  qualite: 0.7,
  prixLu: 78400,
  sourcePrix: 'capture',
  plan: { entree: 78400, stop: 77950, cible1: 79100, ratio: 1.55 },
  dimension: { risquePct: 1, montantRisque: 10, quantite: 0.02, notionnel: 1750, levier: 1.75 },
  moteur: { verdict: 'approuve', refus: [], facteurs: [] },
  raisonnement: {
    contexte: 'c',
    declencheur: 'd',
    invalidation: 'i',
    contreArgument: 'ca',
    nonVisible: ['htf'],
  },
  veille: [],
  reglesAppliquees: [],
  capitalAvant: 1000,
};

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'serveur-'));
  precedent = process.cwd();
  process.chdir(racine);

  const serveur = creerServeur();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const adresse = serveur.address();
  base = `http://127.0.0.1:${typeof adresse === 'object' && adresse ? adresse.port : 0}`;
  fermer = () => new Promise<void>((resolve) => serveur.close(() => resolve()));
});

afterEach(async () => {
  await fermer();
  process.chdir(precedent);
  await rm(racine, { recursive: true, force: true });
});

const poster = (chemin: string, corps: unknown) =>
  fetch(`${base}${chemin}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corps),
  });

describe('routes', () => {
  it('sert la page', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('Copilote de trading');
  });

  it('sert la feuille de style et le script', async () => {
    expect((await fetch(`${base}/style.css`)).status).toBe(200);
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });

  it('refuse de remonter hors du dossier web', async () => {
    // Sans normalisation du chemin, cette requête lirait n'importe quel
    // fichier de la machine. La faille est classique et vaut d'être testée
    // même sur un serveur qui n'écoute qu'en local.
    const r = await fetch(`${base}/../../package.json`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('"dependencies"');
  });

  it('rend l\'état complet, journal vide compris', async () => {
    const r = await fetch(`${base}/api/etat`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as Record<string, never>;
    expect(d).toHaveProperty('etat');
    expect(d).toHaveProperty('bornes');
    expect(d).toHaveProperty('bilan');
    expect(d).toHaveProperty('regles');
  });

  it('répond 404 sur une route inconnue', async () => {
    expect((await fetch(`${base}/api/inexistant`)).status).toBe(404);
  });

  it('refuse une analyse sans image, avec un message utilisable', async () => {
    const r = await poster('/api/analyse', {});
    expect(r.status).toBe(400);
    expect(((await r.json()) as { erreur: string }).erreur).toContain('capture');
  });

  it('refuse un résultat dont l\'issue est inconnue', async () => {
    const r = await poster('/api/resultat', { id: 'T-1', issue: 'peut-etre' });
    expect(r.status).toBe(400);
  });

  it('enregistre un résultat et met à jour le capital', async () => {
    await new Journal().enregistrer(decision);
    const r = await poster('/api/resultat', {
      id: 'T-1',
      issue: 'gain',
      prixSortie: 79100,
      frais: 0,
    });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { rRealise: number; capitalApres: number };
    expect(d.rRealise).toBeCloseTo(1.556, 2);
    expect(d.capitalApres).toBeCloseTo(1015.56, 1);

    const etat = (await (await fetch(`${base}/api/etat`)).json()) as { bilan: { trades: number } };
    expect(etat.bilan.trades).toBe(1);
  });

  it('fait le bilan et régénère les vues', async () => {
    const r = await poster('/api/bilan', {});
    expect(r.status).toBe(200);
    const d = (await r.json()) as { promues: unknown[]; retirees: unknown[] };
    expect(d.promues).toEqual([]);
    expect(d.retirees).toEqual([]);
    expect(await readFile(join(racine, 'memoire/regles.md'), 'utf8')).toContain('Aucune règle');
  });

  it('rend un JSON illisible comme une erreur, pas comme un plantage', async () => {
    const r = await fetch(`${base}/api/resultat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ceci nest pas du json',
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { erreur: string }).erreur).toContain('JSON');
  });
});

describe('enregistrerResultat', () => {
  const poserDecision = async (partiel: Partial<Decision> = {}) => {
    await new Journal().enregistrer({ ...decision, ...partiel });
  };

  const grille = {
    declencheurSurvenu: true,
    executionConforme: true,
    stopTropServe: false,
    processus: 'bon' as const,
    leconEnUnePhrase: null,
  };

  it('calcule le R à partir du plan et du prix de sortie', async () => {
    await poserDecision();
    const r = await enregistrerResultat({ id: 'T-1', issue: 'gain', prixSortie: 79100, frais: 0, analyse: grille });
    // 700 de gain sur 450 de risque.
    expect(r.rRealise).toBeCloseTo(1.556, 2);
  });

  it('calcule le R identiquement à la vente', async () => {
    await poserDecision({
      id: 'T-2',
      sens: 'vente',
      verdict: 'vendre',
      plan: { entree: 78400, stop: 78850, cible1: 77700, ratio: 1.55 },
    });
    const r = await enregistrerResultat({ id: 'T-2', issue: 'gain', prixSortie: 77700, frais: 0, analyse: grille });
    expect(r.rRealise).toBeCloseTo(1.556, 2);
  });

  it('ne touche pas au capital sur un trade non pris', async () => {
    await poserDecision();
    const avant = (await new Compte().charger()).capital;
    const r = await enregistrerResultat({ id: 'T-1', issue: 'non_pris', analyse: grille });
    expect(r.capitalApres).toBe(avant);
    expect(r.rRealise).toBe(0);
  });

  it('refuse une leçon sans étiquette', async () => {
    await poserDecision();
    await expect(
      enregistrerResultat({
        id: 'T-1',
        issue: 'perte',
        analyse: { ...grille, leconEnUnePhrase: "un retest sans volume met plusieurs bougies a repartir" },
      }),
    ).rejects.toThrow(ResultatRefuse);
  });

  it('refuse une leçon qui ne nomme aucune condition observable', async () => {
    await poserDecision();
    await expect(
      enregistrerResultat({
        id: 'T-1',
        issue: 'perte',
        etiquette: 'patience',
        analyse: { ...grille, leconEnUnePhrase: 'il faut être plus patient et respecter le plan' },
      }),
    ).rejects.toThrow(/condition observable|généralité/);
  });

  it('refuse un identifiant inconnu en disant lesquels existent', async () => {
    await poserDecision();
    await expect(
      enregistrerResultat({ id: 'T-999', issue: 'gain', analyse: grille }),
    ).rejects.toThrow(/T-1/);
  });

  it('nomme un gain issu d\'un mauvais processus', async () => {
    await poserDecision();
    const r = await enregistrerResultat({
      id: 'T-1',
      issue: 'gain',
      prixSortie: 79100,
      analyse: { ...grille, processus: 'mauvais' },
    });
    expect(r.remarques.join(' ')).toContain('flatte la méthode');
  });

  it('nomme une perte issue d\'un bon processus', async () => {
    await poserDecision();
    const r = await enregistrerResultat({
      id: 'T-1',
      issue: 'perte',
      prixSortie: 77950,
      analyse: grille,
    });
    expect(r.remarques.join(' ')).toContain('rien à corriger');
  });

  it('distingue un stop trop serré d\'une analyse fausse', async () => {
    await poserDecision();
    const r = await enregistrerResultat({
      id: 'T-1',
      issue: 'perte',
      prixSortie: 77950,
      analyse: { ...grille, stopTropServe: true },
    });
    expect(r.remarques.join(' ')).toContain('placement du stop');
  });

  it('écrit la leçon quand elle est recevable', async () => {
    await poserDecision();
    const r = await enregistrerResultat({
      id: 'T-1',
      issue: 'perte',
      prixSortie: 77950,
      etiquette: 'volume_faible',
      analyse: {
        ...grille,
        leconEnUnePhrase:
          "un retest dont le volume est inférieur à celui de la cassure met plusieurs bougies avant de repartir",
      },
    });
    expect(r.leconId).toBe('L-001');
    const lecons = await readFile(join(racine, 'memoire/lecons.jsonl'), 'utf8');
    expect(lecons).toContain('volume_faible');
  });
});

describe('échappement de l\'interface', () => {
  it('neutralise le HTML de tout ce qui vient du journal ou du modèle', () => {
    // Une leçon, un contre-argument et un symbole mal lu sont du texte libre.
    expect(txt('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(txt('a & b')).toBe('a &amp; b');
    expect(txt('il a dit "non"')).toBe('il a dit &quot;non&quot;');
    expect(txt("l'apostrophe")).toBe('l&#39;apostrophe');
  });

  it('rend une chaîne vide plutôt que « undefined »', () => {
    expect(txt(undefined)).toBe('');
    expect(txt(null)).toBe('');
  });

  it('formate les nombres et les signes en français', () => {
    expect(nb(1234.5)).toBe('1\u202f234,50');
    expect(signe(1.556)).toBe('+1,56');
    expect(signe(-1)).toBe('\u22121,00');
    expect(signe(0)).toBe('0,00');
  });

  it('retire les zéros de queue d\'un prix sans toucher aux décimales utiles', () => {
    expect(prix(1.0912)).toBe('1,0912');
    expect(prix(78400)).toBe('78\u202f400');
  });

  it('classe un résultat par son signe', () => {
    expect(classe(2)).toBe('gain');
    expect(classe(-1)).toBe('perte');
    expect(classe(0)).toBe('neutre');
  });
});

// Garde le fichier honnête si quelqu'un supprime les données de test.
it('le dossier temporaire est bien isolé', async () => {
  await writeFile(join(racine, 'temoin.txt'), 'ok', 'utf8');
  expect(await readFile(join(racine, 'temoin.txt'), 'utf8')).toBe('ok');
});
