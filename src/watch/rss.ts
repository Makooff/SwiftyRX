/**
 * Lecture des flux RSS et Atom.
 *
 * Ne lit que ce que le flux publie — titre, résumé, lien, date. Le corps de
 * l'article n'est jamais récupéré : ce serait aspirer un contenu que l'éditeur
 * n'a pas mis à disposition pour ça.
 *
 * Ce module est la seule source de données de marché du dépôt, et il fonctionne
 * uniquement là où le réseau est ouvert — donc sur ta machine, pas dans une
 * session Claude en cloud, où le proxy refuse ces domaines. Quand il ne peut
 * pas atteindre un flux, il le dit et rend les autres, plutôt que de faire
 * échouer l'ensemble.
 */

import { XMLParser } from 'fast-xml-parser';
import { HttpClient, type FetchImpl } from '../core/http.js';
import { TokenBucket } from '../core/rate-limiter.js';
import { type Clock, systemClock } from '../core/clock.js';
import { paraitManipulateur } from './fencing.js';
import type { Flux } from './feeds.js';

const parseur = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

export interface Depeche {
  titre: string;
  resume: string;
  url?: string;
  publieLe: string;
  fluxId: string;
  fluxNom: string;
  /** Vrai si le texte contient une tournure d'injection de prompt courante. */
  suspect: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function enTableau<T>(valeur: T | T[] | undefined): T[] {
  if (valeur === undefined) return [];
  return Array.isArray(valeur) ? valeur : [valeur];
}

function texte(valeur: unknown): string {
  if (typeof valeur === 'string') return valeur;
  if (valeur && typeof valeur === 'object' && '#text' in (valeur as Record<string, unknown>)) {
    const t = (valeur as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
  }
  return '';
}

function lien(valeur: unknown): string | undefined {
  for (const candidat of enTableau(valeur as any)) {
    if (typeof candidat === 'string' && candidat.trim()) return candidat.trim();
    if (candidat && typeof candidat === 'object' && candidat['@_href']) return candidat['@_href'];
  }
  return undefined;
}

/** Extrait les éléments d'un document RSS 2.0, RDF ou Atom indifféremment. */
export function lireElements(xml: string): any[] {
  const doc = parseur.parse(xml) as Record<string, any>;
  return (
    enTableau(doc?.rss?.channel?.item) ??
    []
  ).concat(enTableau(doc?.['rdf:RDF']?.item), enTableau(doc?.feed?.entry));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function nettoyerHtml(brut: string): string {
  return brut
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OptionsVeille {
  userAgent?: string;
  clock?: Clock;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Politesse : ces flux ne publient pas de quota, on s'en impose un. */
  requetesParMinute?: number;
}

export interface ResultatVeille {
  depeches: Depeche[];
  /** Les flux qui n'ont pas répondu, avec la raison. Jamais masqués. */
  echecs: Array<{ fluxId: string; raison: string }>;
}

export class Veille {
  private readonly http: HttpClient;

  constructor(options: OptionsVeille = {}) {
    this.http = new HttpClient({
      name: 'veille',
      timeoutMs: options.timeoutMs ?? 10_000,
      defaultHeaders: {
        'User-Agent': options.userAgent ?? 'copilote-trading/1.0 (usage personnel)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      rateLimit: new TokenBucket(options.requetesParMinute ?? 20, 60_000, options.clock ?? systemClock),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  /**
   * Récupère les dépêches des flux donnés, publiées après `depuis`.
   *
   * Un flux injoignable n'interrompt pas les autres : la liste des échecs est
   * rendue à côté des dépêches. Une veille qui échoue en silence est pire
   * qu'une veille absente, parce qu'on croit alors qu'il ne s'est rien passé.
   */
  async recuperer(flux: Flux[], depuis: Date): Promise<ResultatVeille> {
    const depeches: Depeche[] = [];
    const echecs: ResultatVeille['echecs'] = [];

    for (const f of flux) {
      try {
        const xml = await this.http.getText(f.url);
        for (const element of lireElements(xml)) {
          const titre = nettoyerHtml(texte(element.title));
          if (!titre) continue;

          const dateBrute =
            texte(element.pubDate) ||
            texte(element.published) ||
            texte(element.updated) ||
            texte(element['dc:date']);
          const publie = dateBrute ? new Date(dateBrute) : undefined;
          if (publie && !Number.isNaN(publie.getTime()) && publie < depuis) continue;

          const resume = nettoyerHtml(
            texte(element.description) || texte(element.summary) || texte(element.content),
          ).slice(0, 600);

          depeches.push({
            titre,
            resume,
            ...(lien(element.link) ? { url: lien(element.link)! } : {}),
            publieLe: publie && !Number.isNaN(publie.getTime()) ? publie.toISOString() : 'date inconnue',
            fluxId: f.id,
            fluxNom: f.nom,
            suspect: paraitManipulateur(`${titre} ${resume}`),
          });
        }
      } catch (err) {
        echecs.push({ fluxId: f.id, raison: err instanceof Error ? err.message : String(err) });
      }
    }

    depeches.sort((a, b) => b.publieLe.localeCompare(a.publieLe));
    return { depeches, echecs };
  }
}
