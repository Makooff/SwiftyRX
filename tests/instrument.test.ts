import { describe, expect, it } from 'vitest';
import { estLiquide, expositionDollar, groupeCorrele, lirePaire } from '../src/risk/instrument.js';

describe('lirePaire', () => {
  it('classe EUR/USD en forex et non en crypto', () => {
    // Le bug de la version précédente : USD figurait dans les devises de
    // cotation crypto, donc EUR/USD était classé crypto et dimensionné comme
    // du bitcoin. Sans conséquence sur un système actions ; grave ici.
    const paire = lirePaire('EUR/USD');
    expect(paire?.classe).toBe('forex');
    expect(paire?.majeure).toBe(true);
  });

  it('classe BTC/USD en crypto', () => {
    expect(lirePaire('BTC/USD')?.classe).toBe('crypto');
  });

  it('classe XAU/USD en métal', () => {
    expect(lirePaire('XAU/USD')?.classe).toBe('metal');
  });

  it('lit la notation collée des captures TradingView', () => {
    expect(lirePaire('EURUSD')?.symbole).toBe('EUR/USD');
    expect(lirePaire('BTCUSDT')?.symbole).toBe('BTC/USDT');
    expect(lirePaire('USDJPY')?.symbole).toBe('USD/JPY');
  });

  it('retire le préfixe de place de marché', () => {
    expect(lirePaire('BINANCE:BTCUSDT')?.symbole).toBe('BTC/USDT');
    expect(lirePaire('OANDA:EURUSD')?.classe).toBe('forex');
  });

  it('accepte les séparateurs courants', () => {
    for (const forme of ['BTC-USD', 'BTC_USD', 'btc/usd', ' BTC / USD ']) {
      expect(lirePaire(forme)?.symbole, forme).toBe('BTC/USD');
    }
  });

  it('rend undefined plutôt que de deviner', () => {
    // Une supposition ici fausse la classe d'actif, donc la taille, donc le
    // risque réel. Mieux vaut poser la question.
    expect(lirePaire('AAPL')).toBeUndefined();
    expect(lirePaire('')).toBeUndefined();
    expect(lirePaire('???')).toBeUndefined();
  });

  it('distingue les majeures des exotiques', () => {
    expect(lirePaire('EUR/USD')?.majeure).toBe(true);
    expect(lirePaire('USD/TRY')?.majeure).toBe(false);
  });
});

describe('expositionDollar', () => {
  it('acheter EUR/USD est un pari contre le dollar', () => {
    expect(expositionDollar(lirePaire('EUR/USD')!, 'achat')).toBe(-1);
  });

  it('acheter USD/JPY est un pari pour le dollar', () => {
    expect(expositionDollar(lirePaire('USD/JPY')!, 'achat')).toBe(1);
  });

  it('les deux paris se compensent au lieu de s\'additionner', () => {
    // Un comptage par nom de groupe verrait deux expositions dollar. Il y en a
    // une seule, et elle est nulle.
    const eurusd = expositionDollar(lirePaire('EUR/USD')!, 'achat');
    const usdjpy = expositionDollar(lirePaire('USD/JPY')!, 'achat');
    expect(eurusd + usdjpy).toBe(0);
  });

  it('une paire sans dollar ne porte pas d\'exposition dollar', () => {
    expect(expositionDollar(lirePaire('EUR/GBP')!, 'achat')).toBe(0);
  });

  it('traite un stablecoin comme du dollar', () => {
    expect(expositionDollar(lirePaire('BTC/USDT')!, 'achat')).toBe(-1);
  });
});

describe('groupeCorrele', () => {
  it('range toutes les cryptos majeures dans le même groupe', () => {
    expect(groupeCorrele(lirePaire('BTC/USD')!)).toBe('crypto');
    expect(groupeCorrele(lirePaire('ETH/USD')!)).toBe('crypto');
  });

  it('donne le même groupe à une paire quel que soit son sens d\'écriture', () => {
    expect(groupeCorrele(lirePaire('EUR/USD')!)).toBe(groupeCorrele(lirePaire('USD/EUR')!));
  });
});

describe('estLiquide', () => {
  it('reconnaît les majeures forex et les cryptos connues', () => {
    expect(estLiquide(lirePaire('EUR/USD')!)).toBe(true);
    expect(estLiquide(lirePaire('BTC/USD')!)).toBe(true);
  });

  it('refuse la liquidité aux exotiques', () => {
    expect(estLiquide(lirePaire('USD/TRY')!)).toBe(false);
  });
});
