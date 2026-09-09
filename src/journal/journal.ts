/**
 * Le journal.
 *
 * Stocké en JSON Lines : ajout seul, greppable, et impossible à corrompre à
 * moitié d'une façon qui perdrait les lignes précédentes.
 *
 * Cette propriété d'ajout seul est la raison pour laquelle un résultat, connu
 * des heures après la décision, s'écrit sur sa propre ligne plutôt qu'en
 * réécrivant la décision. `lireTout` replie chaque résultat sur la décision
 * qu'il complète, si bien que l'appelant voit une entrée avec son résultat et
 * n'a jamais à connaître ce détail. Réécrire le fichier pour corriger un champ
 * échangerait la garantie ci-dessus contre un peu de propreté.
 *
 * Conséquence à assumer : on ne peut pas effacer une décision. C'est voulu.
 * Un journal qu'on peut nettoyer après coup finit nettoyé de ce qui dérange.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Clock, systemClock } from '../core/clock.js';
import { type Decision, type Entree, type Ligne, type Resultat, estResultat } from './types.js';

export const CHEMIN_JOURNAL = 'journal/trades.jsonl';

export interface OptionsJournal {
  chemin?: string;
  clock?: Clock;
}

export class Journal {
  private readonly chemin: string;
  private readonly clock: Clock;

  constructor(options: OptionsJournal = {}) {
    this.chemin = options.chemin ?? CHEMIN_JOURNAL;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * L'identifiant d'une décision : `T-2026-09-09-003`.
   *
   * Lisible à l'œil et triable à la main, ce qui compte davantage qu'un UUID
   * pour un fichier que tu vas ouvrir toi-même.
   */
  async prochainId(): Promise<string> {
    const jour = this.clock.now().toISOString().slice(0, 10);
    const existantes = (await this.lireTout()).filter((e) => e.id.startsWith(`T-${jour}`));
    return `T-${jour}-${String(existantes.length + 1).padStart(3, '0')}`;
  }

  private async ajouter(ligne: Ligne): Promise<void> {
    await mkdir(dirname(this.chemin), { recursive: true });
    await appendFile(this.chemin, `${JSON.stringify(ligne)}\n`, 'utf8');
  }

  /** Enregistre une décision, prise ou non. */
  async enregistrer(decision: Omit<Decision, 'kind' | 'horodatage'>): Promise<Decision> {
    const complete: Decision = {
      ...decision,
      kind: 'decision',
      horodatage: this.clock.now().toISOString(),
    };
    await this.ajouter(complete);
    return complete;
  }

  /**
   * Complète une décision avec ce qui s'est réellement passé.
   *
   * Ré-enregistrer le même identifiant est sans danger : à la lecture, le
   * dernier résultat écrit gagne. Une correction supersède au lieu de
   * dupliquer, et les deux versions restent visibles dans le fichier.
   */
  async enregistrerResultat(resultat: Omit<Resultat, 'kind' | 'horodatage'>): Promise<Resultat> {
    const complet: Resultat = {
      ...resultat,
      kind: 'resultat',
      horodatage: this.clock.now().toISOString(),
    };
    await this.ajouter(complet);
    return complet;
  }

  /** Toutes les décisions, chaque résultat replié sur la sienne, dans l'ordre d'écriture. */
  async lireTout(): Promise<Entree[]> {
    let brut: string;
    try {
      brut = await readFile(this.chemin, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const decisions: Entree[] = [];
    const resultats = new Map<string, Resultat>();

    for (const ligne of brut.split('\n')) {
      if (!ligne.trim()) continue;
      let parsee: Ligne;
      try {
        parsee = JSON.parse(ligne) as Ligne;
      } catch {
        // Une ligne illisible ne doit pas emporter le journal entier : on la
        // saute et on garde le reste, ce qui est tout l'intérêt du JSONL.
        continue;
      }
      if (estResultat(parsee)) resultats.set(parsee.id, parsee);
      else decisions.push({ ...parsee });
    }

    for (const decision of decisions) {
      const resultat = resultats.get(decision.id);
      if (resultat) decision.resultat = resultat;
    }

    return decisions;
  }

  /** Les décisions prises dont le résultat manque encore. */
  async enAttente(): Promise<Entree[]> {
    return (await this.lireTout()).filter((e) => e.verdict !== 'attendre' && !e.resultat);
  }
}
