/**
 * Le capital et ses compteurs.
 *
 * Un seul fichier, `journal/capital.json`, qui répond à quatre questions que
 * le moteur de risque pose avant chaque trade : combien j'ai, combien j'avais
 * ce matin, combien j'avais lundi, et combien de fois j'ai perdu d'affilée.
 *
 * Les bascules de jour et de semaine se font **à la lecture**, en comparant la
 * date stockée à la date du jour. Une bascule qu'il faut penser à déclencher
 * est une bascule qu'on oublie un lundi matin, et l'arrêt hebdomadaire se
 * déclenche alors sur une semaine qui n'existe plus.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Clock, systemClock } from '../core/clock.js';
import { BORNES } from '../settings.js';
import type { EtatCompte, PositionOuverte } from '../risk/types.js';

export const CHEMIN_CAPITAL = 'journal/capital.json';

interface EtatStocke extends EtatCompte {
  /** Jour ISO auquel `capitalDebutJour` se rapporte. */
  jour: string;
  /** Lundi ISO de la semaine à laquelle `capitalDebutSemaine` se rapporte. */
  semaine: string;
  misAJourLe: string;
}

/** Le lundi de la semaine contenant `d`, au format `YYYY-MM-DD`. */
export function lundiDe(d: Date): string {
  const copie = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const jour = copie.getUTCDay();
  copie.setUTCDate(copie.getUTCDate() - (jour === 0 ? 6 : jour - 1));
  return copie.toISOString().slice(0, 10);
}

function etatInitial(maintenant: Date): EtatStocke {
  return {
    capital: BORNES.capitalInitial,
    devise: BORNES.devise,
    capitalDebutJour: BORNES.capitalInitial,
    capitalDebutSemaine: BORNES.capitalInitial,
    plusHaut: BORNES.capitalInitial,
    positions: [],
    tradesAujourdhui: 0,
    pertesConsecutives: 0,
    jour: maintenant.toISOString().slice(0, 10),
    semaine: lundiDe(maintenant),
    misAJourLe: maintenant.toISOString(),
  };
}

export class Compte {
  private readonly chemin: string;
  private readonly clock: Clock;

  constructor(options: { chemin?: string; clock?: Clock } = {}) {
    this.chemin = options.chemin ?? CHEMIN_CAPITAL;
    this.clock = options.clock ?? systemClock;
  }

  /** L'état courant, jour et semaine déjà basculés si besoin. */
  async charger(): Promise<EtatCompte> {
    const maintenant = this.clock.now();
    let stocke: EtatStocke;
    try {
      stocke = JSON.parse(await readFile(this.chemin, 'utf8')) as EtatStocke;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return etatInitial(maintenant);
    }

    const jour = maintenant.toISOString().slice(0, 10);
    const semaine = lundiDe(maintenant);

    if (stocke.jour !== jour) {
      stocke.capitalDebutJour = stocke.capital;
      stocke.tradesAujourdhui = 0;
      stocke.jour = jour;
    }
    if (stocke.semaine !== semaine) {
      stocke.capitalDebutSemaine = stocke.capital;
      stocke.semaine = semaine;
    }

    return stocke;
  }

  private async ecrire(etat: EtatCompte): Promise<void> {
    const maintenant = this.clock.now();
    const stocke: EtatStocke = {
      ...etat,
      jour: maintenant.toISOString().slice(0, 10),
      semaine: lundiDe(maintenant),
      misAJourLe: maintenant.toISOString(),
    };
    await mkdir(dirname(this.chemin), { recursive: true });
    await writeFile(this.chemin, `${JSON.stringify(stocke, null, 2)}\n`, 'utf8');
  }

  /**
   * Applique le résultat d'un trade.
   *
   * `plusHaut` ne redescend jamais : c'est ce qui rend le drawdown mesurable.
   * Un plus haut qui suit le capital vers le bas donnerait un drawdown
   * perpétuellement nul, ce qui est exactement l'inverse de ce qu'on veut
   * savoir.
   */
  async appliquerResultat(input: {
    pnl: number;
    perte: boolean;
    symbole?: string;
  }): Promise<EtatCompte> {
    const etat = await this.charger();
    etat.capital = Number((etat.capital + input.pnl).toFixed(2));
    etat.plusHaut = Math.max(etat.plusHaut, etat.capital);
    etat.tradesAujourdhui += 1;

    if (input.perte) {
      etat.pertesConsecutives += 1;
      etat.dernierePerteLe = this.clock.now().toISOString();
    } else {
      etat.pertesConsecutives = 0;
      delete etat.dernierePerteLe;
    }

    if (input.symbole) {
      etat.positions = etat.positions.filter((p) => p.symbole !== input.symbole);
    }

    await this.ecrire(etat);
    return etat;
  }

  async ouvrirPosition(position: PositionOuverte): Promise<EtatCompte> {
    const etat = await this.charger();
    etat.positions = [...etat.positions.filter((p) => p.symbole !== position.symbole), position];
    await this.ecrire(etat);
    return etat;
  }

  /** Écrit un état complet. Sert au rejeu de la simulation et aux corrections. */
  async remplacer(etat: EtatCompte): Promise<void> {
    await this.ecrire(etat);
  }
}

/** Le drawdown actuel depuis le plus haut, en pourcentage. */
export function drawdownPct(etat: EtatCompte): number {
  if (etat.plusHaut <= 0) return 0;
  return Number((((etat.plusHaut - etat.capital) / etat.plusHaut) * 100).toFixed(2));
}
