/**
 * L'interface, en JavaScript sans dépendance ni étape de construction.
 *
 * Elle ne calcule rien : ni le risque, ni la taille, ni le R. Tout vient du
 * serveur, qui les tient du moteur. Un calcul refait ici finirait par diverger
 * de celui du journal, et c'est exactement le genre d'écart qu'on ne remarque
 * qu'après l'avoir payé.
 */

import { CONFIANCE, classe, LIBELLE_SETUP, nb, prix, signe, txt } from './format.js';

const $ = (id) => document.getElementById(id);

let image = null;
let devise = 'EUR';

async function api(chemin, options) {
  const reponse = await fetch(chemin, options);
  const corps = await reponse.json().catch(() => ({ erreur: 'réponse illisible du serveur' }));
  if (!reponse.ok) throw new Error(corps.erreur ?? `erreur ${reponse.status}`);
  return corps;
}

/* -- dépôt de l'image ---------------------------------------------------- */

function montrerImage(fichier) {
  const lecteur = new FileReader();
  lecteur.onload = () => {
    const url = lecteur.result;
    image = { base64: url.split(',')[1], mediaType: fichier.type || 'image/png' };
    $('cible').innerHTML = `<img src="${url}" alt="La capture que tu viens de déposer">`;
    $('analyser').disabled = false;
    $('effacer').hidden = false;
  };
  lecteur.readAsDataURL(fichier);
}

function reinitialiserDepot() {
  image = null;
  $('cible').innerHTML = '<strong>Dépose ou colle ta capture</strong><small>PNG, JPEG ou WebP</small>';
  $('analyser').disabled = true;
  $('effacer').hidden = true;
  $('fichier').value = '';
}

function brancherDepot() {
  const cible = $('cible');

  cible.addEventListener('click', () => $('fichier').click());
  cible.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('fichier').click();
    }
  });
  $('fichier').addEventListener('change', (e) => {
    if (e.target.files[0]) montrerImage(e.target.files[0]);
  });
  $('effacer').addEventListener('click', reinitialiserDepot);

  for (const nom of ['dragenter', 'dragover']) {
    cible.addEventListener(nom, (e) => {
      e.preventDefault();
      cible.classList.add('survol');
    });
  }
  for (const nom of ['dragleave', 'drop']) {
    cible.addEventListener(nom, (e) => {
      e.preventDefault();
      cible.classList.remove('survol');
    });
  }
  cible.addEventListener('drop', (e) => {
    const fichier = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (fichier) montrerImage(fichier);
  });

  // Coller depuis le presse-papier : c'est le geste naturel après une capture.
  document.addEventListener('paste', (e) => {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        montrerImage(item.getAsFile());
        return;
      }
    }
  });
}

/* -- analyse -------------------------------------------------------------- */

async function analyser() {
  if (!image) return;
  $('analyser').disabled = true;
  $('verdict').innerHTML = '';
  $('etatAnalyse').innerHTML =
    '<p class="chargement"><span class="rond"></span> Lecture du graphique, contexte du compte, puis moteur de risque. Compte une trentaine de secondes.</p>';

  try {
    const r = await api('/api/analyse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: image.base64,
        mediaType: image.mediaType,
        indice: $('indice').value.trim() || undefined,
      }),
    });
    $('etatAnalyse').innerHTML = '';
    afficherVerdict(r);
    await rafraichir();
    $('verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('etatAnalyse').innerHTML = `<p class="message erreur">${txt(err.message)}</p>`;
  } finally {
    $('analyser').disabled = !image;
  }
}

function afficherVerdict(r) {
  const l = r.lecture;
  const m = r.moteur;
  const refuse = m && m.refus.length > 0;
  const mot = refuse ? 'attendre' : l.verdict;

  const puce = (cle, val, fort) =>
    val ? `<li class="${fort ? 'fort' : ''}"><span class="cle">${cle}</span><span class="val">${txt(val)}</span></li>` : '';

  let plan = '';
  if (m && !refuse) {
    plan = `<dl class="plan">
      <div><dt>entrée</dt><dd>${prix(l.entree)}</dd></div>
      <div><dt>stop</dt><dd class="perte">${prix(l.stop)}<span style="font-size:11px"> · ${nb(m.distanceStopPct)} %</span></dd></div>
      <div><dt>cible 1</dt><dd class="gain">${prix(l.cible1)}<span style="font-size:11px"> · ${m.ratio} R</span></dd></div>
      <div><dt>${l.cible2 > 0 ? 'cible 2' : 'risque'}</dt><dd>${
        l.cible2 > 0
          ? `<span class="gain">${prix(l.cible2)}</span><span style="font-size:11px"> · ${m.ratio2 ?? '—'} R</span>`
          : `${nb(m.risquePct)} %`
      }</dd></div>
    </dl>
    <ul class="puces">
      ${puce('risque', `${nb(m.risquePct)} % du capital = ${nb(m.perteSiStop)} ${devise}`, true)}
      ${puce('position', `${m.quantite} unités · ${nb(m.notionnel)} ${devise} · levier ${m.levier}`, true)}
      ${puce('frais', `${Math.round(m.fraisEnR * 100)} % du risque`)}
    </ul>`;
  }

  const reduction =
    m && m.facteurs.length > 1
      ? `<ul class="puces reduction">${m.facteurs
          .slice(1)
          .map((f) => `<li><span class="cle">réduction</span><span class="val">${txt(f.detail)}</span></li>`)
          .join('')}</ul>`
      : '';

  const refusHtml = refuse
    ? `<div class="refus"><p><strong>Le moteur de risque refuse ce trade.</strong></p><ul>${m.refus
        .map((x) => `<li><code>${txt(x.regle)}</code> — ${txt(x.message)}</li>`)
        .join('')}</ul></div>`
    : '';

  const illisible =
    l.illisible.length > 0
      ? `<div class="message erreur">Illisible sur ta capture : ${txt(l.illisible.join(', '))}. Renvoie une image où ces éléments apparaissent, sans quoi la taille de position serait calculée sur une supposition.</div>`
      : '';

  const regles =
    r.regles.length > 0
      ? puce('règles', r.regles.map((x) => `${x.id} (${x.action})`).join(', '))
      : '';

  $('verdict').innerHTML = `<section class="verdict ${mot}">
    <div class="verdict-tete">
      <span class="verdict-mot">${mot.toUpperCase()}</span>
      <span class="verdict-paire">${txt(l.paire || '?')} · ${txt(l.uniteTemps || '?')} · ${l.prixLu ? prix(l.prixLu) : '?'}</span>
      <span class="pastille neutre">qualité ${nb(l.qualite)}</span>
      <span class="pastille neutre">${txt(LIBELLE_SETUP[l.setup] ?? l.setup)}</span>
      ${r.id ? `<span class="ref" style="margin-left:auto">${txt(r.id)}</span>` : ''}
    </div>
    ${illisible}
    ${refusHtml}
    ${plan}
    ${reduction}
    <ul class="puces">
      ${puce('contexte', l.contexte)}
      ${puce('déclencheur', l.declencheur)}
      ${puce('invalidation', l.invalidation)}
      ${puce('contre-argument', l.contreArgument, true)}
      ${puce('non visible', l.nonVisible.join(' · '))}
      ${regles}
      ${puce('ce setup', `${r.stats.n} trades mesurés · ${CONFIANCE[r.stats.confiance] ?? r.stats.confiance}${r.stats.n > 0 ? ` · espérance ${signe(r.stats.esperanceR)} R` : ''}`)}
    </ul>
  </section>`;
}

/* -- état et listes -------------------------------------------------------- */

function afficherBarre(d) {
  devise = d.etat.devise;
  const variation = d.etat.capital - d.bornes.capitalInitial;
  $('capital').textContent = `${nb(d.etat.capital)} ${devise}`;
  $('variation').textContent = `${signe(variation)} depuis le départ · drawdown ${nb(d.etat.drawdownPct, 1)} %`;
  $('variation').className = `mono ${classe(variation)}`;

  const c = [
    ['positions', `${d.etat.positions.length} / ${d.bornes.positionsMax}`],
    ["aujourd'hui", `${d.etat.tradesAujourdhui} / ${d.bornes.tradesParJourMax}`],
    ['pertes d\'affilée', String(d.etat.pertesConsecutives)],
    ['trades dénoués', String(d.bilan.trades)],
    ['espérance nette', d.bilan.trades > 0 ? `${signe(d.bilan.esperanceNetteR)} R` : '—'],
  ];
  $('compteurs').innerHTML = c
    .map(([k, v]) => `<div class="compteur"><dt>${k}</dt><dd>${txt(v)}</dd></div>`)
    .join('');

  $('arrets').innerHTML =
    d.arrets.length > 0
      ? `<div class="alerte"><p class="alerte-titre">Trading arrêté</p><ul>${d.arrets
          .map((a) => `<li>${txt(a.message)}</li>`)
          .join('')}</ul></div>`
      : '';
}

function afficherAttente(d) {
  $('blocAttente').hidden = d.enAttente.length === 0;
  $('compteAttente').textContent = d.enAttente.length ? `${d.enAttente.length}` : '';
  $('attente').innerHTML = d.enAttente
    .map(
      (e) => `<div class="carte" data-id="${txt(e.id)}">
      <div class="carte-tete">
        <span class="ref">${txt(e.id)}</span>
        <strong>${txt(e.symbole)}</strong>
        <span class="pastille ${e.sens === 'achat' ? 'gain' : 'perte'}">${txt(e.sens)}</span>
        <span class="pastille neutre">${txt(LIBELLE_SETUP[e.setup] ?? e.setup)}</span>
        ${e.plan ? `<span class="mono" style="font-size:12px;color:var(--tenu)">entrée ${e.plan.entree} · stop ${e.plan.stop} · cible ${e.plan.cible1}</span>` : ''}
      </div>
      <div class="grille-resultat">
        <select class="issue">
          <option value="gain">gain</option>
          <option value="perte">perte</option>
          <option value="neutre">neutre</option>
          <option value="non_pris">pas pris</option>
        </select>
        <input type="number" step="any" class="sortie" placeholder="prix de sortie">
        <input type="text" class="etiquette" placeholder="étiquette : volume_faible" style="width:180px">
        <button class="envoyer">Enregistrer</button>
        <input type="text" class="lecon large" placeholder="Leçon en une phrase, facultative. Elle doit nommer une condition observable.">
        <div class="bascules">
          <label><input type="checkbox" class="declencheur" checked> le déclencheur s'est produit</label>
          <label><input type="checkbox" class="execution" checked> exécution conforme au plan</label>
          <label><input type="checkbox" class="stopServe"> stop touché puis prix reparti</label>
          <label><input type="checkbox" class="mauvais"> mauvais processus</label>
        </div>
      </div>
      <div class="retour"></div>
    </div>`,
    )
    .join('');

  for (const carte of $('attente').querySelectorAll('.carte')) {
    carte.querySelector('.envoyer').addEventListener('click', () => envoyerResultat(carte));
  }
}

async function envoyerResultat(carte) {
  const q = (s) => carte.querySelector(s);
  const bouton = q('.envoyer');
  const retour = q('.retour');
  bouton.disabled = true;
  retour.innerHTML = '';

  const sortie = q('.sortie').value;
  try {
    const r = await api('/api/resultat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: carte.dataset.id,
        issue: q('.issue').value,
        prixSortie: sortie === '' ? undefined : Number(sortie),
        declencheurSurvenu: q('.declencheur').checked,
        executionConforme: q('.execution').checked,
        stopTropServe: q('.stopServe').checked,
        processus: q('.mauvais').checked ? 'mauvais' : 'bon',
        lecon: q('.lecon').value.trim() || undefined,
        etiquette: q('.etiquette').value.trim() || undefined,
      }),
    });

    const lignes = [
      `R réalisé ${signe(r.rRealise)} · ${signe(r.pnl)} ${devise} (frais ${nb(r.frais)}) · capital ${nb(r.capitalAvant)} → ${nb(r.capitalApres)}`,
      ...r.remarques,
      r.leconId ? `Leçon ${r.leconId} enregistrée.` : '',
    ].filter(Boolean);
    retour.innerHTML = `<p class="message info">${lignes.map(txt).join('<br>')}</p>`;
    await rafraichir();
  } catch (err) {
    retour.innerHTML = `<p class="message erreur">${txt(err.message)}</p>`;
    bouton.disabled = false;
  }
}

function afficherJournal(d) {
  $('compteJournal').textContent = `${d.bilan.decisions} décisions · ${d.bilan.attentes} attentes`;
  if (d.recents.length === 0) {
    $('journal').innerHTML = '<p class="vide">Rien encore. Ta première analyse apparaîtra ici, y compris si le verdict est « attendre ».</p>';
    return;
  }
  $('journal').innerHTML = `<table>
    <thead><tr><th>quand</th><th>paire</th><th>verdict</th><th>setup</th><th class="num">qualité</th><th class="num">R</th><th class="num">résultat</th></tr></thead>
    <tbody>${d.recents
      .map((e) => {
        const r = e.resultat;
        return `<tr>
        <td class="mono" style="font-size:12px;color:var(--tenu)">${txt(e.horodatage.slice(5, 16).replace('T', ' '))}</td>
        <td class="mono">${txt(e.symbole)}</td>
        <td><span class="pastille ${e.verdict === 'acheter' ? 'gain' : e.verdict === 'vendre' ? 'perte' : 'attente'}">${txt(e.verdict)}</span></td>
        <td style="color:var(--doux)">${txt(LIBELLE_SETUP[e.setup] ?? e.setup)}</td>
        <td class="num">${nb(e.qualite)}</td>
        <td class="num ${r ? classe(r.rRealise) : ''}">${r ? signe(r.rRealise) : '—'}</td>
        <td class="num ${r ? classe(r.pnl) : ''}">${r ? `${signe(r.pnl)} ${devise}` : e.refus.length ? 'refusé' : '—'}</td>
      </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

function afficherRegles(d) {
  const actives = d.regles.filter((r) => r.statut === 'active');
  $('compteRegles').textContent = `${actives.length} / ${d.echantillon.reglesActivesMax}`;
  $('regles').innerHTML =
    actives.length === 0
      ? `<p class="vide">Aucune règle active. Il faut ${d.echantillon.leconsPourPromouvoir} leçons concordantes — même setup, même étiquette, toutes issues de trades perdants — pour en promouvoir une.</p>`
      : actives
          .map(
            (r) => `<div class="carte">
        <div class="carte-tete">
          <span class="ref">${txt(r.id)}</span>
          <span class="pastille ${r.action === 'refuser' ? 'perte' : 'attente'}">${r.action === 'refuser' ? 'refuser' : 'réduire de moitié'}</span>
        </div>
        <p>${txt(r.enonce)}</p>
        <p class="mono" style="font-size:12px;color:var(--tenu)">déclenchée sur ${txt(r.declencheur.etiquette)}${r.declencheur.setup ? ` · setup ${txt(r.declencheur.setup)}` : ''} · ${r.preuves.n} observations · espérance ${signe(r.preuves.esperanceR)} R</p>
      </div>`,
          )
          .join('');

  $('lecons').innerHTML =
    d.lecons.length === 0
      ? "<p class=\"vide\">Aucune leçon. Beaucoup de trades n'en produisent pas : une perte propre sur un bon setup est le coût normal du métier.</p>"
      : d.lecons
          .map(
            (l) => `<div class="carte">
        <p>${txt(l.texte)}</p>
        <p class="mono" style="font-size:12px;color:var(--tenu)">${txt(l.etiquette)} · ${txt(l.setup)} · ${txt(l.symbole)} · <span class="${classe(l.rRealise)}">${signe(l.rRealise)} R</span></p>
      </div>`,
          )
          .join('');
}

async function faireBilan() {
  const bouton = $('bilan');
  bouton.disabled = true;
  try {
    const r = await api('/api/bilan', { method: 'POST' });
    const lignes = [];
    if (r.promues.length) lignes.push(`Promues : ${r.promues.map((p) => `${p.id} — ${p.enonce}`).join(' · ')}`);
    if (r.retirees.length) lignes.push(`Retirées : ${r.retirees.map((p) => `${p.id} — ${p.motif}`).join(' · ')}`);
    if (r.bilan.trades > 0) {
      lignes.push(
        `${r.bilan.trades} trades · ${nb(r.bilan.tauxReussitePct, 1)} % · espérance ${signe(r.bilan.esperanceR)} R, ${signe(r.bilan.esperanceNetteR)} R nette · pire série ${r.bilan.pireSerie}`,
      );
      if (r.bilan.esperanceR > 0 && r.bilan.esperanceNetteR <= 0) {
        lignes.push("L'espérance est positive avant frais et nulle après : ces trades déplacent de l'argent vers le broker.");
      }
    }
    if (lignes.length === 0) lignes.push('Rien à promouvoir ni à retirer.');
    $('resumeBilan').innerHTML = `<p class="message info">${lignes.map(txt).join('<br>')}</p>`;
    await rafraichir();
  } catch (err) {
    $('resumeBilan').innerHTML = `<p class="message erreur">${txt(err.message)}</p>`;
  } finally {
    bouton.disabled = false;
  }
}

async function rafraichir() {
  const d = await api('/api/etat');
  afficherBarre(d);
  afficherAttente(d);
  afficherJournal(d);
  afficherRegles(d);
}

brancherDepot();
$('analyser').addEventListener('click', analyser);
$('bilan').addEventListener('click', faireBilan);
rafraichir().catch((err) => {
  $('arrets').innerHTML = `<p class="message erreur">${txt(err.message)}</p>`;
});
