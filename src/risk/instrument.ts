/**
 * Reconnaître ce qu'on regarde à partir de son nom.
 *
 * L'ancienne version de ce fichier classait `EUR/USD` en **crypto**, parce que
 * `USD` figurait dans sa liste de devises de cotation crypto et qu'aucune
 * classe forex n'existait. Le bug était sans conséquence tant que le système
 * ne tradait que des actions américaines ; il en a une ici, où le forex est la
 * moitié du sujet. C'est le premier cas de test du fichier.
 *
 * Deuxième changement : la notation collée est acceptée. L'ancienne version la
 * refusait avec une bonne raison — `BTCUSD` ne se distingue pas d'un ticker
 * d'action sans liste de places de marché. Cette raison a disparu avec les
 * actions. Or les captures TradingView affichent `BTCUSDT` et `EURUSD` sans
 * séparateur, et refuser de les lire aurait voulu dire refuser la source de
 * données principale du système.
 *
 * La découpe reste prudente : elle n'essaie une paire collée que si les deux
 * moitiés sont des codes connus. `AAPL` ne se découpe pas et n'est pas reconnu.
 */

export type ClasseActif = 'crypto' | 'forex' | 'metal' | 'inconnu';

/** Devises souveraines. Les huit majeures d'abord, puis les croisées courantes. */
const DEVISES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR',
  'MXN', 'SGD', 'HKD', 'CNH', 'CNY', 'INR', 'BRL', 'RUB',
]);

/** Les huit majeures : celles dont les paires ont un spread serré et de la profondeur. */
const MAJEURES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

/** Métaux cotés comme des devises. L'or se trade comme une paire, pas comme une action. */
const METAUX = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/** Stablecoins : une cotation en USDT est une cotation en dollar, pour ce qui nous occupe. */
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'BUSD']);

/**
 * Cryptos reconnues comme *base*.
 *
 * Liste volontairement courte : les paires liquides. Une base inconnue cotée
 * contre une devise ou un stablecoin est quand même classée crypto — c'est le
 * cas d'un altcoin récent — mais elle ne bénéficie d'aucune reconnaissance
 * particulière et le moteur de risque le signale.
 */
const CRYPTOS = new Set([
  'BTC', 'XBT', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT',
  'MATIC', 'LINK', 'LTC', 'TRX', 'ATOM', 'UNI', 'ARB', 'OP', 'SUI', 'TON',
]);

const SEPARE = /^([A-Z0-9]{2,10})[/\-_ .]([A-Z0-9]{2,10})$/;

export interface Paire {
  /** Écriture normalisée, toujours avec une barre : `BTC/USD`, `EUR/USD`. */
  symbole: string;
  base: string;
  cotation: string;
  classe: ClasseActif;
  /** Vrai pour une paire forex dont les deux jambes sont des majeures. */
  majeure: boolean;
}

function classer(base: string, cotation: string): ClasseActif {
  if (METAUX.has(base) && (DEVISES.has(cotation) || STABLES.has(cotation))) return 'metal';
  if (DEVISES.has(base) && DEVISES.has(cotation)) return 'forex';
  if (CRYPTOS.has(base) && (DEVISES.has(cotation) || STABLES.has(cotation) || CRYPTOS.has(cotation))) {
    return 'crypto';
  }
  if (STABLES.has(base) || CRYPTOS.has(cotation) || STABLES.has(cotation)) return 'crypto';
  return 'inconnu';
}

/**
 * Découper une paire écrite d'un seul tenant.
 *
 * On essaie les coupes de 3 à 5 caractères sur la cotation, la plus longue
 * d'abord : `BTCUSDT` doit donner `BTC`/`USDT` et non `BTCU`/`SDT`. Une coupe
 * n'est retenue que si elle produit une classe connue.
 */
function decouper(texte: string): { base: string; cotation: string } | undefined {
  for (const taille of [4, 5, 3]) {
    if (texte.length <= taille) continue;
    const base = texte.slice(0, texte.length - taille);
    const cotation = texte.slice(texte.length - taille);
    if (classer(base, cotation) !== 'inconnu') return { base, cotation };
  }
  return undefined;
}

/**
 * Lire un symbole tel qu'il apparaît sur une capture d'écran.
 *
 * Rend `undefined` plutôt que de deviner. Un symbole non reconnu doit
 * provoquer une question à l'utilisateur, jamais une supposition : se tromper
 * de classe d'actif fausse la taille de position, donc le risque réel.
 */
export function lirePaire(symbole: string): Paire | undefined {
  const brut = symbole.trim().toUpperCase().replace(/^(BINANCE|BYBIT|OANDA|FX|COINBASE|KRAKEN):/, '');
  if (!brut) return undefined;

  const separe = SEPARE.exec(brut);
  const parts = separe
    ? { base: separe[1]!, cotation: separe[2]! }
    : decouper(brut.replace(/[^A-Z0-9]/g, ''));

  if (!parts) return undefined;

  const classe = classer(parts.base, parts.cotation);
  if (classe === 'inconnu') return undefined;

  return {
    symbole: `${parts.base}/${parts.cotation}`,
    base: parts.base,
    cotation: parts.cotation,
    classe,
    majeure: classe === 'forex' && MAJEURES.has(parts.base) && MAJEURES.has(parts.cotation),
  };
}

/**
 * Le groupe corrélé auquel une paire appartient.
 *
 * Sert à empêcher de prendre trois fois le même pari sous trois noms. Toutes
 * les cryptos majeures suivent le bitcoin d'assez près pour compter comme une
 * seule exposition ; l'or a sa propre logique ; le forex est traité par
 * l'exposition dollar ci-dessous, plus fine que le groupe.
 */
export function groupeCorrele(paire: Paire): string {
  if (paire.classe === 'crypto') return 'crypto';
  if (paire.classe === 'metal') return 'metaux';
  return `fx:${[paire.base, paire.cotation].sort().join('')}`;
}

/**
 * Exposition au dollar d'une position, en signe.
 *
 * +1 : la position gagne si le dollar monte. −1 : elle gagne s'il baisse.
 * 0 : la paire ne comporte pas de dollar.
 *
 * Acheter EUR/USD et acheter USD/JPY sont deux paris **opposés** sur le
 * dollar ; un simple comptage par groupe les additionnerait comme deux fois le
 * même risque, ce qui est faux dans les deux sens. Cette fonction existe pour
 * que le moteur de risque cumule des expositions et non des noms.
 */
export function expositionDollar(paire: Paire, sens: 'achat' | 'vente'): -1 | 0 | 1 {
  const signe = sens === 'achat' ? 1 : -1;
  const estDollarCotation = paire.cotation === 'USD' || STABLES.has(paire.cotation);
  if (paire.base === 'USD') return signe as -1 | 1;
  if (estDollarCotation) return -signe as -1 | 1;
  return 0;
}

/** Vrai si la paire est suffisamment liquide pour qu'un stop serré ait un sens. */
export function estLiquide(paire: Paire): boolean {
  if (paire.classe === 'metal') return true;
  if (paire.classe === 'forex') return paire.majeure;
  return CRYPTOS.has(paire.base);
}
