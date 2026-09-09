import { describe, expect, it } from 'vitest';
import { MoteurRisque } from '../src/risk/engine.js';
import { calculerTaille, fraisEnR, ratioGainRisque, risqueRecommande } from '../src/risk/sizing.js';
import { BORNES } from '../src/settings.js';
import type { EtatCompte, Proposition } from '../src/risk/types.js';

const compteSain: EtatCompte = {
  capital: 1000,
  devise: 'EUR',
  capitalDebutJour: 1000,
  capitalDebutSemaine: 1000,
  plusHaut: 1000,
  positions: [],
  tradesAujourdhui: 0,
  pertesConsecutives: 0,
};

const proposition: Proposition = {
  symbole: 'BTC/USD',
  sens: 'achat',
  setup: 'retest',
  qualite: 0.7,
  prixEntree: 78400,
  prixStop: 77950,
  prixCible: 79500,
};

describe('risqueRecommande', () => {
  it('ne dépasse jamais le plafond, même à qualité maximale', () => {
    const d = risqueRecommande({
      qualite: 1,
      pertesConsecutives: 0,
      drawdownPct: 0,
      ratio: 5,
      echantillonSetup: 100,
      esperanceSetup: 2,
      liquide: true,
    });
    expect(d.risquePct).toBeLessThanOrEqual(BORNES.risqueMaxPct);
  });

  it("n'a aucun facteur supérieur à 1", () => {
    // C'est l'invariant central : rien ne peut augmenter la mise. Une série
    // gagnante n'a pas de chemin vers une position plus grosse.
    const d = risqueRecommande({
      qualite: 1,
      pertesConsecutives: 0,
      drawdownPct: 0,
      ratio: 10,
      echantillonSetup: 50,
      esperanceSetup: 3,
      liquide: true,
    });
    for (const f of d.facteurs.slice(1)) {
      expect(f.multiplicateur, f.nom).toBeLessThanOrEqual(1);
    }
  });

  it('divise par deux après deux pertes consécutives', () => {
    const base = { qualite: 0.8, drawdownPct: 0, ratio: 3, echantillonSetup: 30, liquide: true };
    const calme = risqueRecommande({ ...base, pertesConsecutives: 0 });
    const serie = risqueRecommande({ ...base, pertesConsecutives: 2 });
    expect(serie.risquePct).toBeCloseTo(calme.risquePct / 2, 2);
  });

  it('réduit quand le setup a une espérance négative mesurée', () => {
    const base = { qualite: 0.8, pertesConsecutives: 0, drawdownPct: 0, ratio: 3, liquide: true };
    const neutre = risqueRecommande({ ...base, echantillonSetup: 30 });
    const mauvais = risqueRecommande({ ...base, echantillonSetup: 30, esperanceSetup: -0.4 });
    expect(mauvais.risquePct).toBeLessThan(neutre.risquePct);
  });

  it('ignore une espérance négative sur un échantillon trop petit', () => {
    // Trois trades ne prouvent rien, et réagir à trois trades est la façon la
    // plus rapide d'apprendre du bruit.
    const d = risqueRecommande({
      qualite: 0.8,
      pertesConsecutives: 0,
      drawdownPct: 0,
      ratio: 3,
      echantillonSetup: 3,
      esperanceSetup: -2,
      liquide: true,
    });
    expect(d.facteurs.some((f) => f.nom === 'esperance_negative')).toBe(false);
  });

  it('rend zéro quand le risque tombe sous le plancher', () => {
    const d = risqueRecommande({
      qualite: 0.05,
      pertesConsecutives: 4,
      drawdownPct: 14,
      ratio: 1.5,
      echantillonSetup: 2,
      liquide: false,
    });
    expect(d.risquePct).toBe(0);
  });
});

describe('calculerTaille', () => {
  it('déduit la quantité du risque et de la distance au stop', () => {
    const t = calculerTaille({ capital: 1000, risquePct: 1, prixEntree: 100, prixStop: 95 });
    // 1 % de 1000 = 10 € ; 5 € de risque par unité ; donc 2 unités.
    expect(t?.quantite).toBeCloseTo(2, 6);
    expect(t?.perteSiStop).toBeCloseTo(10, 2);
    expect(t?.notionnel).toBeCloseTo(200, 2);
    expect(t?.levier).toBeCloseTo(0.2, 2);
  });

  it('donne le même résultat à la vente', () => {
    const achat = calculerTaille({ capital: 1000, risquePct: 1, prixEntree: 100, prixStop: 95 });
    const vente = calculerTaille({ capital: 1000, risquePct: 1, prixEntree: 100, prixStop: 105 });
    expect(vente?.quantite).toBeCloseTo(achat!.quantite, 6);
  });

  it('rend undefined quand le stop est sur le prix d\'entrée', () => {
    // Il n'y a pas de risque défini, donc pas de taille. Rendre une taille
    // infinie serait pire que de ne rien rendre.
    expect(calculerTaille({ capital: 1000, risquePct: 1, prixEntree: 100, prixStop: 100 })).toBeUndefined();
  });

  it('signale que la conversion de devise est supposée', () => {
    const t = calculerTaille({ capital: 1000, risquePct: 1, prixEntree: 100, prixStop: 95 });
    expect(t?.conversionSupposee).toBe(true);
    const converti = calculerTaille({
      capital: 1000,
      risquePct: 1,
      prixEntree: 100,
      prixStop: 95,
      tauxDeviseCompte: 0.92,
    });
    expect(converti?.conversionSupposee).toBe(false);
  });
});

describe('ratioGainRisque', () => {
  it('marche à l\'achat comme à la vente', () => {
    expect(ratioGainRisque(100, 95, 110)).toBe(2);
    expect(ratioGainRisque(100, 105, 90)).toBe(2);
  });

  it('rend zéro sans risque défini', () => {
    expect(ratioGainRisque(100, 100, 110)).toBe(0);
  });
});

describe('fraisEnR', () => {
  it('exprime les frais en fraction du risque', () => {
    // 2000 € de position à 0,1 % = 2 € de frais, sur 10 € de risque = 0,2 R.
    expect(fraisEnR(2000, 10, 0.1)).toBeCloseTo(0.2, 3);
  });
});

describe('MoteurRisque', () => {
  const moteur = new MoteurRisque();

  it('approuve une proposition saine', () => {
    const d = moteur.evaluer(proposition, compteSain);
    expect(d.refus).toHaveLength(0);
    expect(d.risquePct).toBeGreaterThan(0);
    expect(d.quantite).toBeGreaterThan(0);
  });

  it('refuse un ratio sous le minimum', () => {
    const d = moteur.evaluer({ ...proposition, prixCible: 78500 }, compteSain);
    expect(d.refus.map((r) => r.regle)).toContain('ratio_minimum');
  });

  it('refuse un stop du mauvais côté', () => {
    const d = moteur.evaluer({ ...proposition, prixStop: 79000 }, compteSain);
    expect(d.refus.map((r) => r.regle)).toContain('stop_du_bon_cote');
  });

  it('refuse une paire non reconnue plutôt que de deviner', () => {
    const d = moteur.evaluer({ ...proposition, symbole: 'AAPL' }, compteSain);
    expect(d.refus.map((r) => r.regle)).toContain('paire_reconnue');
  });

  it('fait tourner toutes les vérifications même après un refus', () => {
    // Le journal doit montrer l'image complète, pas la première objection.
    const d = moteur.evaluer({ ...proposition, prixCible: 78000, prixStop: 79000 }, compteSain);
    expect(d.refus.map((r) => r.regle)).toEqual(
      expect.arrayContaining(['stop_du_bon_cote', 'cible_du_bon_cote']),
    );
    expect(d.verifications.length).toBeGreaterThan(3);
  });

  it('arrête la journée passé la perte journalière', () => {
    const d = moteur.evaluer(proposition, { ...compteSain, capital: 950 });
    const arret = d.refus.find((r) => r.regle === 'arret_journalier');
    expect(arret?.bloquant).toBe(true);
  });

  it('arrête la semaine passé la perte hebdomadaire', () => {
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      capital: 910,
      capitalDebutJour: 915,
    });
    expect(d.refus.map((r) => r.regle)).toContain('arret_hebdomadaire');
  });

  it('impose un bilan passé le drawdown maximum', () => {
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      capital: 840,
      capitalDebutJour: 845,
      capitalDebutSemaine: 845,
      plusHaut: 1000,
    });
    expect(d.refus.map((r) => r.regle)).toContain('drawdown_maximum');
  });

  it('met en pause après trois pertes consécutives', () => {
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      pertesConsecutives: 3,
      dernierePerteLe: new Date().toISOString(),
    });
    expect(d.refus.map((r) => r.regle)).toContain('pause_apres_pertes');
  });

  it('laisse repasser une fois la pause écoulée', () => {
    const vieux = new Date(Date.now() - (BORNES.pauseMinutes + 10) * 60_000).toISOString();
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      pertesConsecutives: 3,
      dernierePerteLe: vieux,
    });
    expect(d.refus.map((r) => r.regle)).not.toContain('pause_apres_pertes');
  });

  it('refuse au-delà du nombre de positions ouvertes', () => {
    const position = {
      symbole: 'ETH/USD',
      sens: 'achat' as const,
      notionnel: 500,
      risqueOuvert: 10,
      groupeCorrele: 'crypto',
      expositionDollar: -1 as const,
      ouverteLe: new Date().toISOString(),
    };
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      positions: [position, { ...position, symbole: 'SOL/USD' }, { ...position, symbole: 'XRP/USD' }],
    });
    expect(d.refus.map((r) => r.regle)).toContain('positions_simultanees');
  });

  it('refuse quand le risque déjà engagé est au plafond', () => {
    const d = moteur.evaluer(proposition, {
      ...compteSain,
      positions: [
        {
          symbole: 'ETH/USD',
          sens: 'achat',
          notionnel: 500,
          risqueOuvert: 39,
          groupeCorrele: 'or',
          expositionDollar: 0,
          ouverteLe: new Date().toISOString(),
        },
      ],
    });
    expect(d.refus.map((r) => r.regle)).toContain('risque_cumule');
  });

  it("applique une règle apprise qui demande le refus", () => {
    const d = moteur.evaluer(
      {
        ...proposition,
        reglesApprises: [{ id: 'R-01', action: 'refuser', motif: 'session asiatique' }],
      },
      compteSain,
    );
    expect(d.refus.map((r) => r.regle)).toContain('regle_R-01');
  });

  it('réduit de moitié quand une règle apprise le demande', () => {
    const sans = moteur.evaluer(proposition, compteSain);
    const avec = moteur.evaluer(
      {
        ...proposition,
        reglesApprises: [{ id: 'R-02', action: 'reduire', motif: 'volume faible' }],
      },
      compteSain,
    );
    expect(avec.risquePct).toBeCloseTo(sans.risquePct / 2, 2);
  });

  it('ne laisse aucune règle apprise augmenter le risque', () => {
    // Il n'existe pas de valeur d'action qui augmente. Le type l'interdit, et
    // ce test le vérifie sur le comportement.
    const sans = moteur.evaluer(proposition, compteSain);
    const avec = moteur.evaluer(
      {
        ...proposition,
        reglesApprises: [
          { id: 'R-03', action: 'reduire', motif: 'a' },
          { id: 'R-04', action: 'reduire', motif: 'b' },
        ],
      },
      compteSain,
    );
    expect(avec.risquePct).toBeLessThan(sans.risquePct);
  });

  it('ne dépasse jamais le plafond de risque quel que soit le chemin', () => {
    for (const qualite of [0.5, 0.8, 1]) {
      const d = moteur.evaluer({ ...proposition, qualite, prixCible: 90000 }, compteSain);
      expect(d.risquePct, `qualité ${qualite}`).toBeLessThanOrEqual(BORNES.risqueMaxPct);
    }
  });
});
