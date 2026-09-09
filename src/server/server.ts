/**
 * Le serveur de l'application.
 *
 * `node:http` et rien d'autre. L'application tourne sur ta machine, pour toi
 * seul : un serveur de trois cents lignes démarre en un instant, n'ajoute
 * aucune dépendance à surveiller, et se lit en entier. Un framework aurait
 * apporté du routage et du rendu dont cette application n'a pas l'usage.
 *
 * Il n'écoute que sur la boucle locale. Ton journal, ton capital et ta clé API
 * ne quittent pas la machine, et rien sur ton réseau ne peut atteindre ce port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyser, CleManquante } from './analyse.js';
import { enregistrerResultat, ResultatRefuse } from '../journal/resultat.js';
import { Journal } from '../journal/journal.js';
import { Compte, drawdownPct } from '../journal/state.js';
import { bilan } from '../journal/stats.js';
import { chargerMemoire, ecrireRegles, ecrireVues } from '../memory/store.js';
import {
  candidatsPromotion,
  candidatsRetrogradation,
  promouvoir,
  retrograder,
  suivreRegles,
} from '../memory/rules.js';
import { MoteurRisque } from '../risk/engine.js';
import { lirePaire } from '../risk/instrument.js';
import { BORNES, ECHANTILLON } from '../settings.js';
import type { Issue } from '../journal/types.js';

const RACINE_WEB = join(fileURLToPath(new URL('../../src/web', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Taille maximale d'une requête. Une capture d'écran dépasse rarement 4 Mo. */
const CORPS_MAX = 12 * 1024 * 1024;

/** Une erreur imputable à la requête, pas au serveur. */
export class RequeteInvalide extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequeteInvalide';
  }
}

function json(res: ServerResponse, code: number, corps: unknown): void {
  const texte = JSON.stringify(corps);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texte),
    'cache-control': 'no-store',
  });
  res.end(texte);
}

async function lireCorps(req: IncomingMessage): Promise<unknown> {
  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += (morceau as Buffer).length;
    if (taille > CORPS_MAX) {
      throw new Error(`Requête trop grosse (plus de ${Math.round(CORPS_MAX / 1024 / 1024)} Mo).`);
    }
    morceaux.push(morceau as Buffer);
  }
  if (morceaux.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    // Un corps mal formé vient du client : 400, pas 500, et pas de trace
    // dans les journaux du serveur pour quelque chose qu'il n'a pas causé.
    throw new RequeteInvalide('Corps de requête illisible : ce n\'est pas du JSON.');
  }
}

/**
 * Sert un fichier de `src/web`.
 *
 * Le chemin est normalisé puis vérifié : sans ça, une requête contenant `..`
 * lirait n'importe quel fichier de la machine. La faille est classique et vaut
 * les quatre lignes même sur un serveur qui n'écoute qu'en local.
 */
async function servirFichier(res: ServerResponse, chemin: string): Promise<void> {
  const relatif = normalize(chemin === '/' ? '/index.html' : chemin).replace(/^(\.\.[/\\])+/, '');
  const absolu = join(RACINE_WEB, relatif);
  if (!absolu.startsWith(RACINE_WEB)) {
    res.writeHead(403).end('interdit');
    return;
  }
  try {
    const contenu = await readFile(absolu);
    res.writeHead(200, {
      'content-type': TYPES[extname(absolu)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(contenu);
  } catch {
    res.writeHead(404).end('introuvable');
  }
}

/** L'état complet, tel que l'écran l'affiche. */
async function etatComplet() {
  const journal = new Journal();
  const compte = new Compte();
  const memoire = await chargerMemoire();

  const entrees = await journal.lireTout();
  const etat = await compte.charger();
  const stats = bilan(entrees);
  const arrets = new MoteurRisque().conditionsArret(etat);

  return {
    etat: { ...etat, drawdownPct: drawdownPct(etat) },
    bornes: BORNES,
    echantillon: ECHANTILLON,
    bilan: stats,
    arrets: arrets.map((a) => ({ regle: a.regle, message: a.message })),
    regles: memoire.regles,
    lecons: memoire.lecons.slice(-12).reverse(),
    enAttente: entrees
      .filter((e) => e.verdict !== 'attendre' && !e.resultat)
      .map((e) => ({
        id: e.id,
        symbole: e.symbole,
        sens: e.sens,
        setup: e.setup,
        plan: e.plan,
        dimension: e.dimension,
      })),
    recents: entrees
      .slice(-25)
      .reverse()
      .map((e) => ({
        id: e.id,
        horodatage: e.horodatage,
        symbole: e.symbole,
        verdict: e.verdict,
        setup: e.setup,
        qualite: e.qualite,
        refus: e.moteur.refus,
        resultat: e.resultat
          ? { issue: e.resultat.issue, rRealise: e.resultat.rRealise, pnl: e.resultat.pnl }
          : null,
      })),
  };
}

/** Le bilan : suivi, retraits, puis promotions. L'ordre est celui de la commande. */
async function faireBilan() {
  const journal = new Journal();
  let memoire = await chargerMemoire();
  const entrees = await journal.lireTout();
  const stats = bilan(entrees);
  const maintenant = new Date();

  for (const entree of entrees) {
    if (!entree.resultat) continue;
    const paire = lirePaire(entree.symbole);
    if (!paire) continue;
    memoire = suivreRegles(memoire, entree, {
      setup: entree.setup,
      symbole: paire.symbole,
      classe: paire.classe === 'inconnu' ? 'crypto' : paire.classe,
      heureUtc: new Date(entree.horodatage).getUTCHours(),
    });
  }

  const sorties = candidatsRetrogradation(memoire);
  for (const { regle, motif } of sorties) {
    memoire = {
      ...memoire,
      regles: memoire.regles.map((r) => (r.id === regle.id ? retrograder(r, motif, maintenant) : r)),
    };
  }

  const promues: Array<{ id: string; enonce: string }> = [];
  for (const candidat of candidatsPromotion(memoire)) {
    if (memoire.regles.filter((r) => r.statut === 'active').length >= ECHANTILLON.reglesActivesMax) {
      break;
    }
    const regle = promouvoir(candidat, memoire, maintenant);
    memoire = { ...memoire, regles: [...memoire.regles, regle] };
    promues.push({ id: regle.id, enonce: regle.enonce });
  }

  await ecrireRegles(memoire.regles);
  await ecrireVues(memoire, stats);

  return {
    promues,
    retirees: sorties.map(({ regle, motif }) => ({ id: regle.id, motif })),
    bilan: stats,
  };
}

const ISSUES: Issue[] = ['gain', 'perte', 'neutre', 'non_pris'];

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    await servirFichier(res, url.pathname);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/etat') {
    json(res, 200, await etatComplet());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyse') {
    const corps = (await lireCorps(req)) as {
      image?: string;
      mediaType?: string;
      indice?: string;
      taux?: number;
    };
    if (!corps.image) {
      json(res, 400, { erreur: "Aucune image. Dépose une capture de ton graphique." });
      return;
    }
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const mediaType = types.includes(corps.mediaType ?? '') ? corps.mediaType! : 'image/png';
    json(
      res,
      200,
      await analyser({
        image: corps.image,
        mediaType: mediaType as 'image/png',
        ...(corps.indice ? { indice: corps.indice } : {}),
        ...(typeof corps.taux === 'number' ? { taux: corps.taux } : {}),
      }),
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/resultat') {
    const corps = (await lireCorps(req)) as Record<string, unknown>;
    const id = String(corps.id ?? '');
    const issue = String(corps.issue ?? '') as Issue;
    if (!id || !ISSUES.includes(issue)) {
      json(res, 400, { erreur: `id et issue sont requis. issue vaut ${ISSUES.join(', ')}.` });
      return;
    }
    const resultat = await enregistrerResultat({
      id,
      issue,
      ...(typeof corps.prixSortie === 'number' ? { prixSortie: corps.prixSortie } : {}),
      ...(typeof corps.frais === 'number' ? { frais: corps.frais } : {}),
      ...(corps.motifSortie ? { motifSortie: String(corps.motifSortie) } : {}),
      ...(corps.etiquette ? { etiquette: String(corps.etiquette) } : {}),
      analyse: {
        declencheurSurvenu: corps.declencheurSurvenu !== false,
        executionConforme: corps.executionConforme !== false,
        stopTropServe: corps.stopTropServe === true,
        processus: corps.processus === 'mauvais' ? 'mauvais' : 'bon',
        leconEnUnePhrase: corps.lecon ? String(corps.lecon) : null,
      },
    });
    json(res, 200, resultat);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bilan') {
    json(res, 200, await faireBilan());
    return;
  }

  json(res, 404, { erreur: 'route inconnue' });
}

export function creerServeur() {
  return createServer((req, res) => {
    router(req, res).catch((err: unknown) => {
      // Les erreurs attendues portent un message utile ; les autres non, et il
      // vaut mieux le dire que d'afficher une trace au trader.
      const attendue =
        err instanceof CleManquante ||
        err instanceof ResultatRefuse ||
        err instanceof RequeteInvalide;
      const message = attendue
        ? (err as Error).message
        : err instanceof Error
          ? err.message
          : 'erreur inattendue';
      if (!attendue) console.error(err);
      if (!res.headersSent) json(res, attendue ? 400 : 500, { erreur: message });
      else res.end();
    });
  });
}

export function demarrer(port = Number(process.env.PORT ?? 4830)): Promise<string> {
  return new Promise((resolve, reject) => {
    const serveur = creerServeur();
    serveur.on('error', reject);
    // Boucle locale seulement : rien d'autre sur le réseau ne peut l'atteindre.
    serveur.listen(port, '127.0.0.1', () => resolve(`http://localhost:${port}`));
  });
}
