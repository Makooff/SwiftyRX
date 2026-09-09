/**
 * Le tableau de bord, en HTML.
 *
 * Une page unique, sans serveur et sans dépendance : `npm run tableau -- --html`
 * la régénère à partir du journal, et elle s'ouvre dans un navigateur ou se
 * publie telle quelle.
 *
 * Elle est en lecture seule, et c'est délibéré. Saisir un trade ici créerait un
 * deuxième endroit où vivent les données, à côté de `journal/trades.jsonl`, et
 * deux sources de vérité qui divergent en silence sont pires que pas de tableau
 * de bord du tout. Les analyses et les résultats passent par les commandes ; la
 * page montre ce qu'elles ont écrit.
 *
 * Quand le journal est vide, la page affiche un jeu d'exemple **marqué comme
 * tel**. Une coquille vide ne montrerait pas à quoi sert l'outil, et un chiffre
 * inventé présenté comme réel serait pire.
 */

import type { EtatCompte, Refus } from '../risk/types.js';
import { LIBELLE_SETUP } from '../risk/types.js';
import type { Bilan } from './stats.js';
import type { Entree } from './types.js';
import type { Memoire } from '../memory/types.js';
import { BORNES, ECHANTILLON } from '../settings.js';
import { drawdownPct } from './state.js';

export interface DonneesTableau {
  etat: EtatCompte;
  bilan: Bilan;
  memoire: Memoire;
  entrees: Entree[];
  arrets: Refus[];
  /** Vrai quand les chiffres affichés sont un exemple et non tes trades. */
  demonstration: boolean;
}

const echap = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const signe = (n: number, decimales = 2): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(decimales)}`;

const classeSigne = (n: number): string => (n > 0 ? 'gain' : n < 0 ? 'perte' : 'neutre');

const LIBELLE_CONFIANCE: Record<string, string> = {
  indicatif: 'indicatif',
  emergent: 'émergent',
  etabli: 'établi',
};

/**
 * La courbe de capital, en multiples de risque.
 *
 * En R et non en euros : c'est la seule échelle qui reste comparable quand la
 * taille des positions change avec le capital. Une courbe en euros mélange la
 * qualité des décisions et la taille des mises.
 */
function courbe(entrees: Entree[]): string {
  const points: number[] = [0];
  let cumul = 0;
  for (const e of entrees) {
    if (!e.resultat || e.resultat.issue === 'non_pris') continue;
    cumul += e.resultat.rRealise;
    points.push(Number(cumul.toFixed(3)));
  }

  // Trois trades, donc quatre points avec le zéro de départ. Deux points font
  // un segment, et un segment suggère une tendance qui n'existe pas.
  if (points.length < 4) {
    const n = points.length - 1;
    return `<p class="vide">La courbe apparaîtra à partir de trois trades dénoués. Il y en a ${n}.</p>`;
  }

  const G = 48;
  const D = 16;
  const H = 20;
  const B = 30;
  const L = 640;
  const HT = 200;
  const largeur = L - G - D;
  const hauteur = HT - H - B;

  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const etendue = max - min || 1;

  const x = (i: number) => G + (i / (points.length - 1)) * largeur;
  const y = (v: number) => H + (1 - (v - min) / etendue) * hauteur;

  const ligne = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const aire = `${ligne} L${x(points.length - 1).toFixed(1)},${y(min).toFixed(1)} L${G},${y(min).toFixed(1)} Z`;
  const fin = points[points.length - 1]!;
  const positif = fin >= 0;

  return `<figure class="courbe">
  <svg viewBox="0 0 ${L} ${HT}" role="img" aria-label="Cumul du résultat en multiples de risque, de 0 à ${fin.toFixed(2)} R sur ${points.length - 1} trades.">
    <line class="axe" x1="${G}" y1="${y(0).toFixed(1)}" x2="${L - D}" y2="${y(0).toFixed(1)}" />
    <path class="aire ${positif ? 'gain' : 'perte'}" d="${aire}" />
    <path class="trait ${positif ? 'gain' : 'perte'}" d="${ligne}" />
    <circle class="bout ${positif ? 'gain' : 'perte'}" cx="${x(points.length - 1).toFixed(1)}" cy="${y(fin).toFixed(1)}" r="4" />
    <text class="grad" x="${G - 8}" y="${(y(max) + 4).toFixed(1)}" text-anchor="end">${signe(max)} R</text>
    <text class="grad" x="${G - 8}" y="${(y(min) + 4).toFixed(1)}" text-anchor="end">${signe(min)} R</text>
    <text class="grad" x="${G}" y="${HT - 10}">trade 1</text>
    <text class="grad" x="${L - D}" y="${HT - 10}" text-anchor="end">trade ${points.length - 1}</text>
  </svg>
  <figcaption>Cumul en multiples de risque. Un R vaut ce que le stop coûte, quelle que soit la taille.</figcaption>
</figure>`;
}

/** Barre d'espérance, centrée sur zéro : la longueur porte la valeur, le côté porte le signe. */
function barre(valeur: number, maxAbs: number): string {
  const part = maxAbs > 0 ? Math.min(1, Math.abs(valeur) / maxAbs) : 0;
  const largeur = (part * 50).toFixed(1);
  const cote = valeur >= 0 ? `left:50%;width:${largeur}%` : `right:50%;width:${largeur}%`;
  return `<span class="jauge"><span class="jauge-axe"></span><span class="jauge-barre ${classeSigne(valeur)}" style="${cote}"></span></span>`;
}

function sectionEtat(d: DonneesTableau): string {
  const variation = d.etat.capital - BORNES.capitalInitial;
  const dd = drawdownPct(d.etat);
  const risqueEngage = d.etat.positions.reduce((s, p) => s + p.risqueOuvert, 0);

  const compteurs = [
    ['positions ouvertes', `${d.etat.positions.length} / ${BORNES.positionsMax}`],
    ["trades aujourd'hui", `${d.etat.tradesAujourdhui} / ${BORNES.tradesParJourMax}`],
    ['pertes consécutives', String(d.etat.pertesConsecutives)],
    ['risque engagé', `${risqueEngage.toFixed(2)} ${d.etat.devise}`],
  ]
    .map(
      ([label, valeur]) =>
        `<div class="compteur"><dt>${label}</dt><dd>${valeur}</dd></div>`,
    )
    .join('');

  const arrets =
    d.arrets.length > 0
      ? `<div class="alerte" role="status">
      <p class="alerte-titre">Trading arrêté</p>
      <ul>${d.arrets.map((a) => `<li>${echap(a.message)}</li>`).join('')}</ul>
    </div>`
      : '';

  return `<header class="etat">
  <p class="eyebrow">état du compte</p>
  <p class="capital"><span class="montant">${d.etat.capital.toFixed(2)}</span><span class="devise">${d.etat.devise}</span></p>
  <p class="variation ${classeSigne(variation)}">${signe(variation)} depuis le départ · drawdown ${dd.toFixed(1)} % · plus haut ${d.etat.plusHaut.toFixed(2)}</p>
  <dl class="compteurs">${compteurs}</dl>
  ${arrets}
</header>`;
}

function sectionPositions(d: DonneesTableau): string {
  if (d.etat.positions.length === 0) {
    return `<section><h2>Positions</h2><p class="vide">Aucune position ouverte.</p></section>`;
  }
  const lignes = d.etat.positions
    .map(
      (p) => `<tr>
      <th scope="row">${echap(p.symbole)}</th>
      <td><span class="pastille ${p.sens === 'achat' ? 'gain' : 'perte'}">${p.sens}</span></td>
      <td class="num">${p.notionnel.toFixed(0)}</td>
      <td class="num">${p.risqueOuvert.toFixed(2)}</td>
      <td class="discret">${echap(p.groupeCorrele)}</td>
    </tr>`,
    )
    .join('');

  return `<section>
  <h2>Positions</h2>
  <div class="defile"><table>
    <thead><tr><th scope="col">Paire</th><th scope="col">Sens</th><th scope="col" class="num">Notionnel</th><th scope="col" class="num">Risque</th><th scope="col">Groupe</th></tr></thead>
    <tbody>${lignes}</tbody>
  </table></div>
</section>`;
}

function sectionPerformance(d: DonneesTableau): string {
  const b = d.bilan;

  if (b.trades === 0) {
    return `<section>
  <h2>Performance</h2>
  <p class="vide">${b.decisions} décision${b.decisions > 1 ? 's' : ''} enregistrée${b.decisions > 1 ? 's' : ''}, aucun trade dénoué. Rien n'est mesurable, et rien ne sera affirmé.</p>
</section>`;
  }

  const chiffres = [
    ['trades dénoués', String(b.trades), ''],
    ['réussite', `${b.tauxReussitePct} %`, ''],
    ['espérance', `${signe(b.esperanceR)} R`, classeSigne(b.esperanceR)],
    ['espérance nette', `${signe(b.esperanceNetteR)} R`, classeSigne(b.esperanceNetteR)],
    ['cumul', `${signe(b.cumulR)} R`, classeSigne(b.cumulR)],
    ['pire série', String(b.pireSerie), ''],
    ['frais payés', `${b.fraisTotaux.toFixed(2)} ${d.etat.devise}`, ''],
    ['attentes', String(b.attentes), ''],
  ]
    .map(
      ([label, valeur, cls]) =>
        `<div class="chiffre"><dt>${label}</dt><dd class="${cls}">${valeur}</dd></div>`,
    )
    .join('');

  const avertissements: string[] = [];
  if (b.trades < ECHANTILLON.minimumPourRegler) {
    avertissements.push(
      `${b.trades} trades sur les ${ECHANTILLON.minimumPourRegler} nécessaires pour qu'un chiffre d'ici serve à décider quoi que ce soit.`,
    );
  }
  if (b.esperanceR > 0 && b.esperanceNetteR <= 0) {
    avertissements.push(
      "L'espérance est positive avant frais et nulle ou négative après. Ces trades ne rapportent rien : ils déplacent de l'argent vers le broker.",
    );
  }

  const note =
    avertissements.length > 0
      ? `<ul class="notes">${avertissements.map((a) => `<li>${a}</li>`).join('')}</ul>`
      : '';

  return `<section>
  <h2>Performance</h2>
  <dl class="chiffres">${chiffres}</dl>
  ${note}
  ${courbe(d.entrees)}
</section>`;
}

function sectionSetups(d: DonneesTableau): string {
  const setups = [...d.bilan.parSetup].sort((a, b) => b.esperanceR - a.esperanceR);
  if (setups.length === 0) {
    return `<section>
  <h2>Par setup</h2>
  <p class="vide">Aucun setup mesuré. La taxonomie compte neuf entrées, fermée exprès : sans vocabulaire fixe, les statistiques ne s'agrègent jamais.</p>
</section>`;
  }

  const maxAbs = Math.max(...setups.map((s) => Math.abs(s.esperanceR)), 0.1);
  const lignes = setups
    .map(
      (s) => `<tr>
      <th scope="row">${LIBELLE_SETUP[s.setup]}</th>
      <td class="num">${s.n}</td>
      <td class="num">${s.tauxReussitePct} %</td>
      <td class="num ${classeSigne(s.esperanceR)}">${signe(s.esperanceR)} R</td>
      <td class="num ${classeSigne(s.esperanceNetteR)}">${signe(s.esperanceNetteR)} R</td>
      <td>${barre(s.esperanceR, maxAbs)}</td>
      <td><span class="chip ${s.confiance}">${LIBELLE_CONFIANCE[s.confiance]}</span></td>
    </tr>`,
    )
    .join('');

  const suspects = setups.filter((s) => s.gainsParChance > 0 || s.stopsTropServes > 0);
  const aRegarder =
    suspects.length > 0
      ? `<ul class="notes">${suspects
          .flatMap((s) => [
            s.gainsParChance > 0
              ? `<li><b>${LIBELLE_SETUP[s.setup]}</b> — ${s.gainsParChance} gain${s.gainsParChance > 1 ? 's' : ''} issu${s.gainsParChance > 1 ? 's' : ''} d'un mauvais processus. Le résultat flatte la méthode.</li>`
              : '',
            s.stopsTropServes > 0
              ? `<li><b>${LIBELLE_SETUP[s.setup]}</b> — ${s.stopsTropServes} stop${s.stopsTropServes > 1 ? 's' : ''} touché${s.stopsTropServes > 1 ? 's' : ''} avant que le prix reparte dans le bon sens. C'est le placement du stop, pas l'analyse.</li>`
              : '',
          ])
          .filter(Boolean)
          .join('')}</ul>`
      : '';

  return `<section>
  <h2>Par setup</h2>
  <div class="defile"><table>
    <thead><tr><th scope="col">Setup</th><th scope="col" class="num">n</th><th scope="col" class="num">Réussite</th><th scope="col" class="num">Espérance</th><th scope="col" class="num">Nette</th><th scope="col"><span class="sr">Répartition</span></th><th scope="col">Confiance</th></tr></thead>
    <tbody>${lignes}</tbody>
  </table></div>
  ${aRegarder}
</section>`;
}

function sectionRegles(d: DonneesTableau): string {
  const actives = d.memoire.regles.filter((r) => r.statut === 'active');
  const retirees = d.memoire.regles.filter((r) => r.statut === 'retrogradee');

  const corps =
    actives.length === 0
      ? `<p class="vide">Aucune règle active. Il en faut ${ECHANTILLON.leconsPourPromouvoir} leçons concordantes — même setup, même étiquette, toutes issues de trades perdants — pour en promouvoir une. ${d.memoire.lecons.length} leçon${d.memoire.lecons.length > 1 ? 's' : ''} enregistrée${d.memoire.lecons.length > 1 ? 's' : ''} pour l'instant.</p>`
      : `<ul class="regles">${actives
          .map(
            (r) => `<li>
        <p class="regle-tete"><span class="ref">${r.id}</span><span class="pastille ${r.action === 'refuser' ? 'perte' : 'attention'}">${r.action === 'refuser' ? 'refuser' : 'réduire de moitié'}</span></p>
        <p class="regle-enonce">${echap(r.enonce)}</p>
        <p class="regle-preuve">déclenchée sur <code>${echap(r.declencheur.etiquette)}</code>${r.declencheur.setup ? ` · setup ${r.declencheur.setup}` : ''} · ${r.preuves.n} observations, espérance ${signe(r.preuves.esperanceR)} R · promue le ${r.promueLe.slice(0, 10)}</p>
      </li>`,
          )
          .join('')}</ul>`;

  const mortes =
    retirees.length > 0
      ? `<h3>Règles retirées</h3><ul class="regles fanees">${retirees
          .map(
            (r) =>
              `<li><p class="regle-tete"><span class="ref">${r.id}</span></p><p class="regle-enonce">${echap(r.enonce)}</p><p class="regle-preuve">retirée le ${r.retrogradeeLe?.slice(0, 10)} — ${echap(r.motifRetrogradation ?? '')}</p></li>`,
          )
          .join('')}</ul>`
      : '';

  return `<section>
  <h2>Règles apprises <span class="compte">${actives.length} / ${ECHANTILLON.reglesActivesMax}</span></h2>
  <p class="chapeau">Une règle ne peut que <b>refuser</b> un trade ou <b>réduire</b> sa taille. Aucune ne peut en autoriser un que les bornes refusent, ni agrandir une position.</p>
  ${corps}
  ${mortes}
</section>`;
}

function sectionLecons(d: DonneesTableau): string {
  const recentes = [...d.memoire.lecons].reverse().slice(0, 6);
  if (recentes.length === 0) {
    return `<section>
  <h2>Leçons</h2>
  <p class="vide">Aucune leçon. Beaucoup de trades n'en produisent pas : une perte propre sur un bon setup est le coût normal du métier, pas une erreur à corriger.</p>
</section>`;
  }

  return `<section>
  <h2>Leçons récentes</h2>
  <ul class="lecons">${recentes
    .map(
      (l) => `<li>
    <p class="lecon-texte">${echap(l.texte)}</p>
    <p class="lecon-meta"><code>${echap(l.etiquette)}</code> · ${l.setup} · ${echap(l.symbole)} · <span class="${classeSigne(l.rRealise)}">${signe(l.rRealise)} R</span></p>
  </li>`,
    )
    .join('')}</ul>
</section>`;
}

function sectionAttente(d: DonneesTableau): string {
  const attente = d.entrees.filter((e) => e.verdict !== 'attendre' && !e.resultat);
  if (attente.length === 0) return '';
  return `<section class="rappel">
  <h2>Sans résultat</h2>
  <p>${attente.length} trade${attente.length > 1 ? 's' : ''} pris dont le résultat n'a pas été rapporté. Tant qu'il manque, il ne compte dans aucune statistique.</p>
  <ul class="ids">${attente.map((e) => `<li><code>${echap(e.id)}</code> ${echap(e.symbole)}</li>`).join('')}</ul>
</section>`;
}

function sectionFonctionnement(): string {
  const etapes: Array<[string, string]> = [
    ['Tu envoies une capture', "La paire, l'unité de temps et le prix sont lus à l'écran. S'ils ne sont pas lisibles, la question est posée plutôt que devinée."],
    ['Veille et mémoire', "Ce qui bouge la paire maintenant, daté et sourcé. Et les règles apprises qui s'appliquent à ce setup."],
    ['Lecture du graphique', 'Structure, niveaux, setup nommé dans une taxonomie fermée, et une note de qualité entre 0 et 1.'],
    ['Moteur de risque', "Il reçoit des nombres, jamais la capture ni le raisonnement. Il décide du pourcentage, calcule la taille, ou refuse en nommant la règle."],
    ['Verdict', 'Acheter, vendre ou attendre. Écrit au journal dans les trois cas.'],
    ['Tu rapportes le résultat', 'Capital mis à jour, grille en cinq questions, et une leçon quand il y en a une.'],
  ];

  const commandes: Array<[string, string]> = [
    ['npm run tableau', 'cet écran, en une page'],
    ['npm run contexte', 'ce que la mémoire sait, avant une analyse'],
    ['npm run risque', 'le verdict du moteur et toutes ses vérifications'],
    ['npm run decision', 'enregistre une analyse au journal'],
    ['npm run resultat', 'enregistre ce qui s\'est passé, met à jour le capital'],
    ['npm run bilan', 'promeut et retire les règles'],
    ['npm run simulation', 'la vérification de bout en bout'],
  ];

  const bornes: Array<[string, string]> = [
    ['risque par trade', `${BORNES.risqueMinPct} % à ${BORNES.risqueMaxPct} %`],
    ['arrêt de la journée', `−${BORNES.arretJournalierPct} %`],
    ['arrêt de la semaine', `−${BORNES.arretHebdomadairePct} %`],
    ['drawdown maximum', `${BORNES.arretDrawdownPct} %`],
    ['pause après', `${BORNES.pertesAvantPause} pertes, ${BORNES.pauseMinutes} min`],
    ['ratio minimum', `${BORNES.ratioMinimum}`],
  ];

  return `<section class="doc">
  <h2>Comment ça marche</h2>

  <ol class="etapes">${etapes
    .map(([titre, texte]) => `<li><p class="etape-titre">${titre}</p><p>${texte}</p></li>`)
    .join('')}</ol>

  <h3>Les bornes, qui ne se négocient pas</h3>
  <p class="chapeau">Le pourcentage de risque est choisi à chaque trade selon la qualité du setup, son espérance mesurée, le drawdown en cours et la corrélation avec ce qui est déjà ouvert. Ces bornes-ci sont du code.</p>
  <dl class="bornes">${bornes
    .map(([label, valeur]) => `<div><dt>${label}</dt><dd>${valeur}</dd></div>`)
    .join('')}</dl>
  <p class="apres">Rien ne peut augmenter la mise, pas même une série de gains. Tous les facteurs de calcul valent 1 au plus. L'asymétrie est voulue : dix pertes d'affilée à ${BORNES.risqueMaxPct} % coûtent 18 % du capital, dont on revient ; à 5 % elles en coûtent 40 %, et il faut alors gagner 67 % pour revenir à zéro.</p>

  <h3>Les commandes</h3>
  <div class="defile"><table class="cmd">
    <tbody>${commandes
      .map(([c, quoi]) => `<tr><th scope="row"><code>${echap(c)}</code></th><td>${quoi}</td></tr>`)
      .join('')}</tbody>
  </table></div>

  <h3>Ce que ce système ne fait pas</h3>
  <p>Il ne prédit pas les prix, et aucun système ne le fait. Il donne une taille de position calculée au lieu d'estimée, un refus quand le contexte ne s'y prête pas, une trace de chaque décision y compris celles qui n'ont produit aucun trade, et une mémoire qui se corrige avec des preuves plutôt qu'avec des impressions.</p>
  <p>Une analyse ne vaut que ce que vaut la capture : sans le contexte des unités de temps supérieures, sans le volume réel, sans le carnet d'ordres, la lecture est partielle et chaque analyse le dit. Aucun ordre n'est passé depuis ce dépôt. Tu exécutes toi-même.</p>
</section>`;
}

const STYLE = `
:root {
  --fond: #EDEFF3;
  --surface: #FFFFFF;
  --surface-creuse: #E4E8EE;
  --bord: #D2D8E1;
  --bord-net: #B7C0CD;
  --texte: #171C24;
  --texte-doux: #5A6474;
  --texte-tenu: #838E9E;
  --laiton: #96692A;
  --laiton-vif: #B5832F;
  --gain: #2F7A66;
  --perte: #A8493A;
  --attention: #96692A;
  --voile-gain: rgba(47, 122, 102, 0.12);
  --voile-perte: rgba(168, 73, 58, 0.12);
  --ombre: 0 1px 2px rgba(23, 28, 36, .05), 0 8px 24px -18px rgba(23, 28, 36, .35);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --fond: #0E1219;
    --surface: #161C26;
    --surface-creuse: #1D2531;
    --bord: #262F3D;
    --bord-net: #384456;
    --texte: #E6EAF0;
    --texte-doux: #9AA5B4;
    --texte-tenu: #6B7789;
    --laiton: #D6A75E;
    --laiton-vif: #E3B968;
    --gain: #5FBFA3;
    --perte: #D9816F;
    --attention: #D9A85E;
    --voile-gain: rgba(95, 191, 163, 0.14);
    --voile-perte: rgba(214, 129, 111, 0.14);
    --ombre: 0 1px 2px rgba(0, 0, 0, .4), 0 12px 32px -20px rgba(0, 0, 0, .8);
  }
}

:root[data-theme="dark"] {
  --fond: #0E1219;
  --surface: #161C26;
  --surface-creuse: #1D2531;
  --bord: #262F3D;
  --bord-net: #384456;
  --texte: #E6EAF0;
  --texte-doux: #9AA5B4;
  --texte-tenu: #6B7789;
  --laiton: #D6A75E;
  --laiton-vif: #E3B968;
  --gain: #5FBFA3;
  --perte: #D9816F;
  --attention: #D9A85E;
  --voile-gain: rgba(95, 191, 163, 0.14);
  --voile-perte: rgba(214, 129, 111, 0.14);
  --ombre: 0 1px 2px rgba(0, 0, 0, .4), 0 12px 32px -20px rgba(0, 0, 0, .8);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--fond);
  color: var(--texte);
  font-family: 'Archivo', ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.page {
  max-width: 940px;
  margin: 0 auto;
  padding: clamp(20px, 4vw, 52px) clamp(16px, 4vw, 32px) 72px;
  display: flex;
  flex-direction: column;
  gap: 34px;
}

h1, h2, h3 { font-family: 'Newsreader', ui-serif, Georgia, serif; font-weight: 500; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(26px, 4vw, 34px); letter-spacing: -.01em; }
h2 { font-size: 21px; display: flex; align-items: baseline; gap: 10px; }
h3 { font-size: 17px; margin-top: 26px; }
p { margin: 0; }

.eyebrow {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--texte-tenu);
}

.banniere {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  padding: 12px 16px;
  border: 1px dashed var(--bord-net);
  border-radius: 3px;
  background: var(--surface-creuse);
  font-size: 13.5px;
  color: var(--texte-doux);
}
.banniere b { color: var(--texte); font-weight: 600; }

.entete { display: flex; flex-direction: column; gap: 6px; }
.entete p.sous { color: var(--texte-doux); max-width: 62ch; }

section { display: flex; flex-direction: column; gap: 14px; }

.etat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: clamp(20px, 3vw, 30px);
  background: var(--surface);
  border: 1px solid var(--bord);
  border-radius: 4px;
  box-shadow: var(--ombre);
}

.capital { display: flex; align-items: baseline; gap: 9px; }
.capital .montant {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: clamp(38px, 8vw, 60px);
  font-weight: 700;
  letter-spacing: -.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.capital .devise { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 17px; color: var(--texte-tenu); }
.variation { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; color: var(--texte-doux); font-variant-numeric: tabular-nums; }

.compteurs {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  margin: 8px 0 0;
  background: var(--bord);
  border: 1px solid var(--bord);
  border-radius: 3px;
  overflow: hidden;
}
.compteur { background: var(--surface); padding: 11px 13px; }
.compteur dt { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--texte-tenu); }
.compteur dd {
  margin: 3px 0 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.alerte {
  margin-top: 6px;
  padding: 13px 16px;
  border-left: 3px solid var(--perte);
  background: var(--voile-perte);
  border-radius: 0 3px 3px 0;
}
.alerte-titre { font-weight: 600; color: var(--perte); letter-spacing: .02em; }
.alerte ul { margin: 6px 0 0; padding-left: 18px; font-size: 14px; color: var(--texte-doux); }

.chiffres {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  margin: 0;
  background: var(--bord);
  border: 1px solid var(--bord);
  border-radius: 3px;
  overflow: hidden;
}
.chiffre { background: var(--surface); padding: 12px 14px; }
.chiffre dt { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--texte-tenu); }
.chiffre dd {
  margin: 4px 0 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.gain { color: var(--gain); }
.perte { color: var(--perte); }
.neutre { color: var(--texte-doux); }

.defile { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
thead th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--texte-tenu);
  padding: 0 12px 8px 0;
  border-bottom: 1px solid var(--bord-net);
  white-space: nowrap;
}
tbody th { text-align: left; font-weight: 500; }
tbody th, tbody td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--bord); vertical-align: middle; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
th.num { padding-right: 0; }
.discret { color: var(--texte-tenu); font-size: 13px; }

.jauge { position: relative; display: block; width: 84px; height: 16px; }
.jauge-axe { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--bord-net); }
.jauge-barre { position: absolute; top: 4px; height: 8px; border-radius: 1px; }
.jauge-barre.gain { background: var(--gain); }
.jauge-barre.perte { background: var(--perte); }

.chip, .pastille {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 2px;
  font-size: 11px;
  letter-spacing: .04em;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  white-space: nowrap;
}
.chip.indicatif { background: var(--surface-creuse); color: var(--texte-tenu); }
.chip.emergent { background: var(--voile-perte); color: var(--attention); }
.chip.etabli { background: var(--voile-gain); color: var(--gain); }
.pastille.gain { background: var(--voile-gain); color: var(--gain); }
.pastille.perte { background: var(--voile-perte); color: var(--perte); }
.pastille.attention { background: var(--voile-perte); color: var(--attention); }

.compte { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: var(--texte-tenu); font-weight: 400; }
.chapeau { color: var(--texte-doux); font-size: 14px; max-width: 68ch; }
.vide { color: var(--texte-doux); font-size: 14px; max-width: 68ch; }
.notes { margin: 2px 0 0; padding-left: 18px; color: var(--texte-doux); font-size: 13.5px; display: flex; flex-direction: column; gap: 5px; }
.notes b { color: var(--texte); font-weight: 600; }

.courbe { margin: 6px 0 0; display: flex; flex-direction: column; gap: 8px; }
.courbe svg { width: 100%; height: auto; display: block; }
.courbe .axe { stroke: var(--bord-net); stroke-width: 1; stroke-dasharray: 3 3; }
.courbe .trait { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.courbe .trait.gain { stroke: var(--gain); }
.courbe .trait.perte { stroke: var(--perte); }
.courbe .aire { stroke: none; }
.courbe .aire.gain { fill: var(--voile-gain); }
.courbe .aire.perte { fill: var(--voile-perte); }
.courbe .bout.gain { fill: var(--gain); }
.courbe .bout.perte { fill: var(--perte); }
.courbe .grad { fill: var(--texte-tenu); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; }
figcaption { color: var(--texte-tenu); font-size: 12.5px; }

.regles, .lecons, .ids { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.regles li {
  padding: 13px 15px;
  background: var(--surface);
  border: 1px solid var(--bord);
  border-left: 3px solid var(--laiton);
  border-radius: 0 3px 3px 0;
}
.regles.fanees li { border-left-color: var(--bord-net); opacity: .68; }
.regle-tete { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; }
.ref { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: var(--laiton); font-weight: 700; letter-spacing: .04em; }
.regle-enonce { font-size: 14.5px; }
.regle-preuve { margin-top: 5px; font-size: 12.5px; color: var(--texte-tenu); font-family: 'JetBrains Mono', ui-monospace, monospace; }

.lecons li { padding-left: 14px; border-left: 2px solid var(--bord-net); }
.lecon-texte { font-size: 14.5px; }
.lecon-meta { margin-top: 3px; font-size: 12px; color: var(--texte-tenu); font-family: 'JetBrains Mono', ui-monospace, monospace; }

.rappel { padding: 15px 17px; background: var(--surface-creuse); border-radius: 3px; }
.rappel p { font-size: 14px; color: var(--texte-doux); }
.ids li { font-size: 13px; color: var(--texte-doux); }

code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: .88em;
  background: var(--surface-creuse);
  padding: 1px 5px;
  border-radius: 2px;
}

.doc { padding-top: 12px; border-top: 1px solid var(--bord-net); }
.doc p { color: var(--texte-doux); font-size: 14.5px; max-width: 68ch; }
.etapes { counter-reset: e; list-style: none; margin: 4px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 18px 26px; }
.etapes li { counter-increment: e; }
.etape-titre { font-weight: 600; color: var(--texte) !important; font-size: 14.5px; display: flex; align-items: baseline; gap: 8px; }
.etape-titre::before {
  content: counter(e);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--laiton);
  font-weight: 700;
}
.etapes li p:last-child { font-size: 13.5px; margin-top: 3px; }

.bornes { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px 22px; margin: 4px 0 0; }
.bornes dt { font-size: 12px; color: var(--texte-tenu); letter-spacing: .03em; }
.bornes dd { margin: 1px 0 0; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 15px; color: var(--texte); font-variant-numeric: tabular-nums; }
.apres { margin-top: 10px; }

table.cmd { font-size: 14px; }
table.cmd th { white-space: nowrap; padding-right: 20px; }
table.cmd td { color: var(--texte-doux); }

.pied { color: var(--texte-tenu); font-size: 12.5px; font-family: 'JetBrains Mono', ui-monospace, monospace; }

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (min-width: 620px) {
  .compteurs, .chiffres { grid-template-columns: repeat(4, 1fr); }
}

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/** Le document complet. `complet: false` rend le contenu seul, pour publication. */
export function rendreTableauHtml(d: DonneesTableau, options: { complet?: boolean } = {}): string {
  const banniere = d.demonstration
    ? `<p class="banniere"><b>Exemple.</b> Le journal est vide, alors la page montre des chiffres fabriqués pour donner à voir ce qu'elle affiche. Ce ne sont pas tes trades. Ils disparaissent au premier résultat réel.</p>`
    : '';

  const maj = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const tete = `<title>Copilote de trading</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap">
<style>${STYLE}</style>`;

  const corps = `<main class="page">
  <div class="entete">
    <p class="eyebrow">crypto · forex · journal à mémoire</p>
    <h1>Copilote de trading</h1>
    <p class="sous">Tu envoies une capture, il répond acheter, vendre ou attendre. Tu rapportes le résultat, le capital suit et la mémoire se corrige.</p>
  </div>
  ${banniere}
  ${sectionEtat(d)}
  ${sectionPositions(d)}
  ${sectionAttente(d)}
  ${sectionPerformance(d)}
  ${sectionSetups(d)}
  ${sectionRegles(d)}
  ${sectionLecons(d)}
  ${sectionFonctionnement()}
  <p class="pied">généré le ${maj} par npm run tableau -- --html</p>
</main>`;

  // Publié en artefact, le squelette html/head/body est ajouté au moment de la
  // publication : on ne rend alors que la tête et le corps, sans les balises.
  if (options.complet === false) return `${tete}\n${corps}`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${tete}
</head>
<body>
${corps}
</body>
</html>`;
}
