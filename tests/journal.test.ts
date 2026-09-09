import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal } from '../src/journal/journal.js';
import { Compte, drawdownPct, lundiDe } from '../src/journal/state.js';
import { bilan, coutDeLaPrudence, pireSerie, statsParSetup } from '../src/journal/stats.js';
import type { Decision } from '../src/journal/types.js';

let racine: string;
let journal: Journal;

const squelette: Omit<Decision, 'kind' | 'horodatage' | 'id'> = {
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
  racine = await mkdtemp(join(tmpdir(), 'journal-'));
  journal = new Journal({ chemin: join(racine, 'trades.jsonl') });
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

describe('Journal', () => {
  it('rend une liste vide quand le fichier n\'existe pas', async () => {
    expect(await journal.lireTout()).toEqual([]);
  });

  it('replie le résultat sur la décision qu\'il complète', async () => {
    await journal.enregistrer({ ...squelette, id: 'T-1' });
    await journal.enregistrerResultat({
      id: 'T-1',
      issue: 'gain',
      prixSortie: 79100,
      rRealise: 1.55,
      pnl: 15.5,
      frais: 1.75,
      capitalApres: 1015.5,
      motifSortie: 'TP1',
      analyse: {
        declencheurSurvenu: true,
        executionConforme: true,
        stopTropServe: false,
        processus: 'bon',
        leconEnUnePhrase: null,
      },
    });

    const entrees = await journal.lireTout();
    expect(entrees).toHaveLength(1);
    expect(entrees[0]?.resultat?.rRealise).toBe(1.55);
  });

  it('n\'écrase jamais une ligne : les deux versions restent sur le disque', async () => {
    // C'est la propriété d'ajout seul. Un journal qu'on peut corriger en place
    // finit corrigé de ce qui dérange.
    await journal.enregistrer({ ...squelette, id: 'T-1' });
    const base = {
      id: 'T-1',
      prixSortie: 79100,
      pnl: 0,
      frais: 0,
      capitalApres: 1000,
      motifSortie: '',
      analyse: {
        declencheurSurvenu: true,
        executionConforme: true,
        stopTropServe: false,
        processus: 'bon' as const,
        leconEnUnePhrase: null,
      },
    };
    await journal.enregistrerResultat({ ...base, issue: 'perte', rRealise: -1 });
    await journal.enregistrerResultat({ ...base, issue: 'gain', rRealise: 2 });

    const brut = await readFile(join(racine, 'trades.jsonl'), 'utf8');
    expect(brut.trim().split('\n')).toHaveLength(3);

    // Le dernier écrit gagne à la lecture.
    const entrees = await journal.lireTout();
    expect(entrees[0]?.resultat?.rRealise).toBe(2);
  });

  it('saute une ligne illisible sans perdre les autres', async () => {
    await journal.enregistrer({ ...squelette, id: 'T-1' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(racine, 'trades.jsonl'), '{ceci n\'est pas du JSON\n', 'utf8');
    await journal.enregistrer({ ...squelette, id: 'T-2' });

    const entrees = await journal.lireTout();
    expect(entrees.map((e) => e.id)).toEqual(['T-1', 'T-2']);
  });

  it('numérote les identifiants dans la journée', async () => {
    const un = await journal.prochainId();
    await journal.enregistrer({ ...squelette, id: un });
    const deux = await journal.prochainId();
    expect(deux).not.toBe(un);
    expect(deux.endsWith('002')).toBe(true);
  });

  it('liste les trades pris dont le résultat manque, sans compter les attentes', async () => {
    await journal.enregistrer({ ...squelette, id: 'T-1' });
    await journal.enregistrer({ ...squelette, id: 'T-2', verdict: 'attendre', sens: null });
    const attente = await journal.enAttente();
    expect(attente.map((e) => e.id)).toEqual(['T-1']);
  });
});

describe('Compte', () => {
  it('part du capital initial quand rien n\'est enregistré', async () => {
    const compte = new Compte({ chemin: join(racine, 'capital.json') });
    const etat = await compte.charger();
    expect(etat.capital).toBe(1000);
    expect(etat.plusHaut).toBe(1000);
  });

  it('ne fait jamais redescendre le plus haut', async () => {
    // Un plus haut qui suit le capital vers le bas donnerait un drawdown
    // perpétuellement nul, c'est-à-dire l'inverse de ce qu'on veut mesurer.
    const compte = new Compte({ chemin: join(racine, 'capital.json') });
    await compte.appliquerResultat({ pnl: 100, perte: false });
    await compte.appliquerResultat({ pnl: -200, perte: true });
    const etat = await compte.charger();
    expect(etat.capital).toBe(900);
    expect(etat.plusHaut).toBe(1100);
    expect(drawdownPct(etat)).toBeCloseTo(18.18, 1);
  });

  it('remet le compteur de pertes à zéro sur un gain', async () => {
    const compte = new Compte({ chemin: join(racine, 'capital.json') });
    await compte.appliquerResultat({ pnl: -10, perte: true });
    await compte.appliquerResultat({ pnl: -10, perte: true });
    expect((await compte.charger()).pertesConsecutives).toBe(2);
    await compte.appliquerResultat({ pnl: 20, perte: false });
    expect((await compte.charger()).pertesConsecutives).toBe(0);
  });

  it('bascule la journée à la lecture, sans qu\'on ait à y penser', async () => {
    const hier = new Date(Date.now() - 26 * 3_600_000);
    const compteHier = new Compte({ chemin: join(racine, 'capital.json'), clock: figeA(hier) });
    await compteHier.appliquerResultat({ pnl: -50, perte: true });

    const compteAujourdhui = new Compte({ chemin: join(racine, 'capital.json') });
    const etat = await compteAujourdhui.charger();
    expect(etat.capitalDebutJour).toBe(950);
    expect(etat.tradesAujourdhui).toBe(0);
  });
});

function figeA(date: Date) {
  return {
    now: () => date,
    nowMs: () => date.getTime(),
    sleep: async () => {},
  };
}

describe('lundiDe', () => {
  it('rend le lundi de la semaine, y compris un dimanche', () => {
    expect(lundiDe(new Date('2026-09-09T12:00:00Z'))).toBe('2026-09-07');
    expect(lundiDe(new Date('2026-09-13T12:00:00Z'))).toBe('2026-09-07');
    expect(lundiDe(new Date('2026-09-07T00:00:00Z'))).toBe('2026-09-07');
  });
});

describe('statistiques', () => {
  const trade = (id: string, r: number, options: Partial<Decision> = {}) => ({
    ...squelette,
    ...options,
    kind: 'decision' as const,
    id,
    horodatage: new Date().toISOString(),
    resultat: {
      kind: 'resultat' as const,
      id,
      horodatage: new Date().toISOString(),
      issue: (r > 0 ? 'gain' : r < 0 ? 'perte' : 'neutre') as 'gain' | 'perte' | 'neutre',
      prixSortie: 79000,
      rRealise: r,
      pnl: r * 10,
      frais: 1,
      capitalApres: 1000,
      motifSortie: '',
      analyse: {
        declencheurSurvenu: true,
        executionConforme: true,
        stopTropServe: false,
        processus: 'bon' as 'bon' | 'mauvais',
        leconEnUnePhrase: null,
      },
    },
  });

  it('calcule l\'espérance et la retire des frais', () => {
    const s = statsParSetup([trade('a', 2), trade('b', -1)], 'retest');
    expect(s.n).toBe(2);
    expect(s.esperanceR).toBe(0.5);
    // 1 € de frais sur 10 € de risque = 0,1 R par trade.
    expect(s.esperanceNetteR).toBeCloseTo(0.4, 2);
  });

  it('étiquette la confiance selon l\'échantillon', () => {
    expect(statsParSetup([trade('a', 1)], 'retest').confiance).toBe('indicatif');
    const dix = Array.from({ length: 12 }, (_, i) => trade(`t${i}`, 1));
    expect(statsParSetup(dix, 'retest').confiance).toBe('emergent');
    const trente = Array.from({ length: 25 }, (_, i) => trade(`u${i}`, 1));
    expect(statsParSetup(trente, 'retest').confiance).toBe('etabli');
  });

  it('compte les gains issus d\'un mauvais processus', () => {
    const chanceux = trade('a', 2);
    chanceux.resultat.analyse.processus = 'mauvais';
    expect(statsParSetup([chanceux], 'retest').gainsParChance).toBe(1);
  });

  it('mesure la pire série de pertes', () => {
    expect(pireSerie([trade('a', -1), trade('b', -1), trade('c', 2), trade('d', -1)])).toBe(2);
  });

  it('ne compte pas les attentes comme des trades', () => {
    const attente = { ...squelette, kind: 'decision' as const, id: 'x', horodatage: '', verdict: 'attendre' as const, sens: null };
    const b = bilan([trade('a', 1), attente]);
    expect(b.trades).toBe(1);
    expect(b.attentes).toBe(1);
    expect(b.decisions).toBe(2);
  });

  it('dit qu\'on ignore le coût de la prudence tant que rien n\'est suivi', () => {
    const attente = { ...squelette, kind: 'decision' as const, id: 'x', horodatage: '', verdict: 'attendre' as const, sens: null };
    const c = coutDeLaPrudence([attente]);
    expect(c.ecartes).toBe(1);
    expect(c.suivis).toBe(0);
  });
});
