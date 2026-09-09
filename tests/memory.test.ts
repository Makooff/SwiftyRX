import { describe, expect, it } from 'vitest';
import {
  candidatsPromotion,
  candidatsRetrogradation,
  promouvoir,
  reglesApplicables,
  retrograder,
  sApplique,
  tropDeRegles,
} from '../src/memory/rules.js';
import { leconRecevable, rendreReglesMd } from '../src/memory/store.js';
import type { Lecon, Memoire, Regle } from '../src/memory/types.js';

const lecon = (i: number, etiquette: string, r = -1): Lecon => ({
  id: `L-${i}`,
  horodatage: '2026-09-09T10:00:00Z',
  tradeId: `T-${i}`,
  setup: 'retest',
  sens: 'achat',
  symbole: 'EUR/USD',
  etiquette,
  texte: "un retest en session asiatique sur les majeures n'a pas le volume pour tenir",
  rRealise: r,
});

const vide: Memoire = { lecons: [], regles: [] };

describe('promotion', () => {
  it('ne promeut rien sous trois leçons', () => {
    const memoire = { ...vide, lecons: [lecon(1, 'asie'), lecon(2, 'asie')] };
    expect(candidatsPromotion(memoire)).toHaveLength(0);
  });

  it('promeut à la troisième leçon concordante', () => {
    const memoire = { ...vide, lecons: [lecon(1, 'asie'), lecon(2, 'asie'), lecon(3, 'asie')] };
    expect(candidatsPromotion(memoire)).toHaveLength(1);
  });

  it('ne promeut pas des leçons qui se contredisent', () => {
    // Trois leçons sur le même schéma dont une vient d'un gain : le schéma
    // n'est pas établi, il est contredit.
    const memoire = {
      ...vide,
      lecons: [lecon(1, 'asie'), lecon(2, 'asie'), lecon(3, 'asie', 2)],
    };
    expect(candidatsPromotion(memoire)).toHaveLength(0);
  });

  it('ne regroupe pas des leçons d\'étiquettes différentes', () => {
    // Sans étiquette commune, deux belles phrases ne concordent jamais.
    const memoire = {
      ...vide,
      lecons: [lecon(1, 'asie'), lecon(2, 'volume'), lecon(3, 'contre_htf')],
    };
    expect(candidatsPromotion(memoire)).toHaveLength(0);
  });

  it('demande un refus quand la perte moyenne est franche', () => {
    const memoire = { ...vide, lecons: [lecon(1, 'asie'), lecon(2, 'asie'), lecon(3, 'asie')] };
    expect(candidatsPromotion(memoire)[0]?.action).toBe('refuser');
  });

  it('demande seulement une réduction quand la perte est modérée', () => {
    const memoire = {
      ...vide,
      lecons: [lecon(1, 'asie', -0.3), lecon(2, 'asie', -0.4), lecon(3, 'asie', -0.2)],
    };
    expect(candidatsPromotion(memoire)[0]?.action).toBe('reduire');
  });

  it('ne repromeut pas un schéma déjà couvert par une règle', () => {
    const memoire = { ...vide, lecons: [lecon(1, 'asie'), lecon(2, 'asie'), lecon(3, 'asie')] };
    const regle = promouvoir(candidatsPromotion(memoire)[0]!, memoire, new Date());
    const apres = { ...memoire, regles: [regle] };
    expect(candidatsPromotion(apres)).toHaveLength(0);
  });

  it('ne produit jamais qu\'un refus ou une réduction', () => {
    // Il n'existe pas de règle apprise qui autorise ou qui agrandit. Une
    // mémoire capable de lever ses propres garde-fous finit par le faire.
    const memoire = { ...vide, lecons: [lecon(1, 'asie'), lecon(2, 'asie'), lecon(3, 'asie')] };
    for (const c of candidatsPromotion(memoire)) {
      expect(['refuser', 'reduire']).toContain(c.action);
    }
  });
});

describe('application', () => {
  const regle: Regle = {
    id: 'R-01',
    enonce: 'pas de retest en session asiatique',
    action: 'refuser',
    declencheur: { setup: 'retest', etiquette: 'asie', heuresUtc: [0, 6] },
    preuves: { n: 3, tauxReussitePct: 0, esperanceR: -1, lecons: ['L-1'] },
    statut: 'active',
    promueLe: '2026-09-09T10:00:00Z',
    suivi: [],
  };

  it('se déclenche dans sa plage horaire', () => {
    expect(sApplique(regle, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 3 })).toBe(true);
  });

  it('ne se déclenche pas hors de sa plage', () => {
    expect(sApplique(regle, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 14 })).toBe(false);
  });

  it('gère une plage qui passe minuit', () => {
    const nuit = { ...regle, declencheur: { ...regle.declencheur, heuresUtc: [22, 4] as [number, number] } };
    expect(sApplique(nuit, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 23 })).toBe(true);
    expect(sApplique(nuit, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 2 })).toBe(true);
    expect(sApplique(nuit, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 12 })).toBe(false);
  });

  it('ne se déclenche pas sur un autre setup', () => {
    expect(sApplique(regle, { setup: 'cassure', symbole: 'EUR/USD', classe: 'forex', heureUtc: 3 })).toBe(false);
  });

  it('ne s\'applique plus une fois retrogradée', () => {
    const morte = retrograder(regle, 'testée', new Date());
    expect(sApplique(morte, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 3 })).toBe(false);
  });

  it('filtre la liste des règles applicables', () => {
    const memoire: Memoire = { lecons: [], regles: [regle] };
    const dedans = reglesApplicables(memoire, { setup: 'retest', symbole: 'EUR/USD', classe: 'forex', heureUtc: 3 });
    expect(dedans).toHaveLength(1);
  });
});

describe('rétrogradation', () => {
  const base: Regle = {
    id: 'R-01',
    enonce: 'e',
    action: 'refuser',
    declencheur: { etiquette: 'asie' },
    preuves: { n: 3, tauxReussitePct: 0, esperanceR: -1, lecons: [] },
    statut: 'active',
    promueLe: '2026-09-09T10:00:00Z',
    suivi: [],
  };

  it('retire une règle qui a écarté trois trades gagnants', () => {
    const memoire: Memoire = {
      lecons: [],
      regles: [
        {
          ...base,
          suivi: [
            { tradeId: 'a', rRealise: 2, filtre: true },
            { tradeId: 'b', rRealise: 1, filtre: true },
            { tradeId: 'c', rRealise: 3, filtre: true },
          ],
        },
      ],
    };
    expect(candidatsRetrogradation(memoire)).toHaveLength(1);
  });

  it('ne compte pas les trades pris malgré la règle', () => {
    // La distinction est tout le mécanisme : un trade pris malgré la règle ne
    // dit rien sur ce que la règle a coûté.
    const memoire: Memoire = {
      lecons: [],
      regles: [
        {
          ...base,
          suivi: [
            { tradeId: 'a', rRealise: 2, filtre: false },
            { tradeId: 'b', rRealise: 1, filtre: false },
            { tradeId: 'c', rRealise: 3, filtre: false },
          ],
        },
      ],
    };
    expect(candidatsRetrogradation(memoire)).toHaveLength(0);
  });

  it('retire une règle dont le régime a changé', () => {
    const suivi = Array.from({ length: 22 }, (_, i) => ({
      tradeId: `t${i}`,
      rRealise: 0.5,
      filtre: false,
    }));
    const memoire: Memoire = { lecons: [], regles: [{ ...base, suivi }] };
    const sorties = candidatsRetrogradation(memoire);
    expect(sorties).toHaveLength(1);
    expect(sorties[0]?.motif).toContain('régime');
  });

  it('garde le motif du retrait', () => {
    const morte = retrograder(base, 'elle coûtait plus qu\'elle ne protégeait', new Date());
    expect(morte.statut).toBe('retrogradee');
    expect(morte.motifRetrogradation).toContain('coûtait');
  });
});

describe('plafond de règles', () => {
  it('signale au-delà de douze règles actives', () => {
    const regles = Array.from({ length: 12 }, (_, i) => ({
      id: `R-${i}`,
      enonce: 'e',
      action: 'reduire' as const,
      declencheur: { etiquette: `e${i}` },
      preuves: { n: 3, tauxReussitePct: 0, esperanceR: -1, lecons: [] },
      statut: 'active' as const,
      promueLe: '2026-09-09T10:00:00Z',
      suivi: [],
    }));
    expect(tropDeRegles({ lecons: [], regles })).toBe(true);
    expect(tropDeRegles({ lecons: [], regles: regles.slice(0, 5) })).toBe(false);
  });
});

describe('leconRecevable', () => {
  it('accepte une leçon qui nomme une condition observable', () => {
    expect(
      leconRecevable("un retest en session asiatique sur les majeures n'a pas le volume pour tenir").ok,
    ).toBe(true);
  });

  it('refuse une généralité qui s\'applique partout', () => {
    expect(leconRecevable('il faut être plus patient et respecter le plan').ok).toBe(false);
    expect(leconRecevable("je dois travailler ma discipline et mes émotions en trading").ok).toBe(false);
  });

  it('refuse une phrase trop courte pour être testable', () => {
    expect(leconRecevable('trop tôt').ok).toBe(false);
  });

  it('refuse un paragraphe', () => {
    expect(leconRecevable('mot '.repeat(60)).ok).toBe(false);
  });
});

describe('rendreReglesMd', () => {
  it('dit franchement quand il n\'y a rien', () => {
    expect(rendreReglesMd(vide)).toContain('Aucune règle');
  });

  it('rappelle qu\'une règle ne peut que refuser ou réduire', () => {
    expect(rendreReglesMd(vide)).toContain('refuser');
  });
});
