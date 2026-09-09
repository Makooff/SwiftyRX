import { describe, expect, it } from 'vitest';
import { rendreTableauHtml } from '../src/journal/html.js';
import { jeuDeDemonstration } from '../src/journal/demo.js';
import type { DonneesTableau } from '../src/journal/html.js';

const vide: DonneesTableau = {
  etat: {
    capital: 1000,
    devise: 'EUR',
    capitalDebutJour: 1000,
    capitalDebutSemaine: 1000,
    plusHaut: 1000,
    positions: [],
    tradesAujourdhui: 0,
    pertesConsecutives: 0,
  },
  bilan: {
    decisions: 0,
    trades: 0,
    attentes: 0,
    refusMoteur: 0,
    gains: 0,
    pertes: 0,
    tauxReussitePct: 0,
    esperanceR: 0,
    esperanceNetteR: 0,
    cumulR: 0,
    fraisTotaux: 0,
    pireSerie: 0,
    parSetup: [],
  },
  memoire: { lecons: [], regles: [] },
  entrees: [],
  arrets: [],
  demonstration: false,
};

describe('rendreTableauHtml', () => {
  it('rend un document complet par défaut', () => {
    const html = rendreTableauHtml(vide);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<body>');
    expect(html).toContain('</html>');
  });

  it('rend le contenu seul pour publication', () => {
    // L'artefact ajoute lui-même html/head/body ; les répéter casserait la page.
    const html = rendreTableauHtml(vide, { complet: false });
    expect(html).not.toContain('<!doctype');
    expect(html).not.toContain('<body>');
    expect(html).toContain('<title>');
  });

  it('dit franchement quand il n\'y a rien à mesurer', () => {
    const html = rendreTableauHtml(vide);
    expect(html).toContain('aucun trade dénoué');
    expect(html).toContain('rien ne sera affirmé');
  });

  it('déclare toutes ses couleurs avant de les redéfinir par thème', () => {
    // Une couleur dont l'unique définition vit dans un bloc @media ou
    // [data-theme] ne s'applique pas dans l'état non marqué, et la page rend
    // alors le texte d'un thème sur le fond de l'autre.
    const html = rendreTableauHtml(vide);
    const racine = html.slice(html.indexOf(':root {'), html.indexOf('@media (prefers-color-scheme'));
    const sombre = html.slice(html.indexOf(':root[data-theme="dark"]'));
    const jetons = [...sombre.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]!);
    for (const jeton of new Set(jetons)) {
      expect(racine, `${jeton} manque dans :root`).toContain(`${jeton}:`);
    }
  });

  it('échappe le contenu venu du journal', () => {
    const piege: DonneesTableau = {
      ...vide,
      memoire: {
        regles: [],
        lecons: [
          {
            id: 'L-1',
            horodatage: '2026-09-09T10:00:00Z',
            tradeId: 'T-1',
            setup: 'retest',
            sens: 'achat',
            symbole: '<script>alert(1)</script>',
            etiquette: 'test',
            texte: 'une leçon avec un <b>chevron</b> & une esperluette',
            rRealise: -1,
          },
        ],
      },
    };
    const html = rendreTableauHtml(piege);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('marque le jeu de démonstration comme fabriqué', () => {
    const html = rendreTableauHtml(jeuDeDemonstration());
    expect(html).toContain('Exemple.');
    expect(html).toContain('Ce ne sont pas tes trades');
  });

  it('dessine une courbe dont les graduations nomment les valeurs atteintes', () => {
    const demo = jeuDeDemonstration();
    const html = rendreTableauHtml(demo);
    const cumul = demo.bilan.cumulR;
    expect(html).toContain('viewBox');
    // La graduation haute doit valoir au moins le cumul final, sinon la courbe
    // sortirait du cadre.
    const graduations = [...html.matchAll(/class="grad"[^>]*>([+−][\d.]+) R</g)].map((m) =>
      Number(m[1]!.replace('−', '-').replace('+', '')),
    );
    expect(Math.max(...graduations)).toBeGreaterThanOrEqual(cumul - 0.01);
  });

  it('ne dessine pas de courbe sous trois trades, et dit combien il en faut', () => {
    // Deux points ne font pas une courbe. La page le dit plutôt que de tracer
    // un segment qui suggérerait une tendance.
    const demo = jeuDeDemonstration();
    const deux = {
      ...demo,
      entrees: demo.entrees.filter((e) => e.resultat).slice(0, 2),
    };
    const html = rendreTableauHtml({ ...deux, bilan: { ...deux.bilan, trades: 2 } });
    expect(html).toContain('La courbe apparaîtra à partir de trois trades');
    expect(html).not.toContain('viewBox');
  });
});

describe('jeuDeDemonstration', () => {
  it('produit un scénario moyen, pas une courbe qui monte', () => {
    // Un exemple flatteur donnerait une idée fausse de ce que l'outil promet.
    const d = jeuDeDemonstration();
    expect(d.bilan.trades).toBe(14);
    expect(d.bilan.pertes).toBeGreaterThan(4);
    expect(d.bilan.pireSerie).toBeGreaterThanOrEqual(3);
  });

  it('montre les frais qui mangent l\'espérance', () => {
    const d = jeuDeDemonstration();
    expect(d.bilan.esperanceNetteR).toBeLessThan(d.bilan.esperanceR);
  });

  it('compte les attentes sans les compter comme des trades', () => {
    const d = jeuDeDemonstration();
    expect(d.bilan.attentes).toBe(2);
    expect(d.bilan.decisions).toBe(16);
  });

  it('contient une règle promue par trois leçons concordantes', () => {
    const d = jeuDeDemonstration();
    const regle = d.memoire.regles[0]!;
    expect(regle.preuves.lecons).toHaveLength(3);
    expect(['refuser', 'reduire']).toContain(regle.action);
  });
});
