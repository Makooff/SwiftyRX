---
name: analyse
description: Analyse un graphique crypto ou forex et rend un verdict ACHETER, VENDRE ou ATTENDRE avec entrée, stop loss, take profit et pourcentage de risque. Use when the user sends a chart screenshot, names a pair, or asks whether to buy or sell. Trigger on capture de graphique, "j'achète ou je vends", "je prends ?", BTC, ETH, EUR/USD, XAU/USD, scalp, setup, "t'en penses quoi".
---

# Analyse

L'utilisateur envoie une capture d'écran de graphique, ou nomme une paire. Tu rends un verdict.

## L'ordre, et il ne change pas

**1. Lire la capture.** Extrais ce qui est écrit à l'écran : la paire, l'unité de temps, le prix courant, la structure visible. Si l'un des trois premiers n'est pas lisible, **pose la question**. Ne suppose jamais un prix : toute la taille de position en dépend.

**2. Le contexte mémoire.** Lance l'agent `memoire`. Si le trading est arrêté, dis-le tout de suite et arrête-toi là.

**3. La veille.** Lance l'agent `veille` sur la paire. Une publication macro dans les minutes qui viennent change le verdict, quel que soit le graphique.

Les étapes 2 et 3 sont indépendantes : lance les deux agents dans le même message.

**4. Lire le graphique.** Structure, niveaux, phase de marché. Nomme le setup dans la taxonomie fermée. Attribue une qualité entre 0 et 1.

**5. Le risque.** Lance l'agent `risque` avec les prix et la qualité. Sa réponse fait foi. Tu ne recalcules pas la taille toi-même.

**6. Enregistrer.** Écris la décision au journal, y compris quand le verdict est « attendre » et y compris quand le moteur a refusé.

## Le format de sortie

```
BTC/USD · 15 min · 78 400 $ · lu sur ta capture · 09/09 14:32

VERDICT : ACHETER
Qualité du setup : 0,68 — confiance moyenne

• Contexte — hausse sur 4 h, repli sur 15 min vers le support de la cassure
• Setup — retest
• Déclencheur — mèche de rejet sur 78 200, ancien sommet devenu support
• Entrée — 78 400 au marché
• Stop — 77 950, sous le creux de structure, −0,57 %
• TP1 — 79 100, +0,89 %, la moitié de la position
• TP2 — 79 850, +1,85 %, le reste
• Ratio — 1,55 puis 3,20
• Risque — 0,85 % du capital = 8,50 € → position 1 482 € (levier 1,48)
• Invalidation — clôture 15 min sous 78 150 : le scénario est mort avant le stop
• Veille — CPI américain à 14:30, dans 10 minutes, impact fort
• Règles appliquées — R-02, taille réduite après 2 pertes
• Contre-argument — le volume du retest est inférieur à celui de la cassure
• Non visible sur ta capture — contexte journalier, volume réel, carnet d'ordres

npm run resultat -- --id T-2026-09-09-001 --issue gain|perte|neutre
```

Deux lignes ne sont pas décoratives et ne peuvent pas être omises. **Contre-argument** oblige à formuler ce qui ferait échouer le trade avant de le prendre. **Non visible** empêche d'inventer ce qui n'est pas à l'écran. La commande `npm run decision` refuse une analyse à laquelle il en manque une.

## ATTENDRE

C'est un verdict à part entière, pas un aveu d'échec. Il s'écrit au journal comme les autres, avec le même soin : setup, contexte, pourquoi maintenant n'est pas le moment, et ce qui te ferait changer d'avis.

Sans ça, le journal ne garde que les trades pris et le bilan flatte forcément le système. Le nombre d'attentes est un chiffre suivi, et le bilan mesure ce que la prudence coûte quand tu rapportes après coup ce qu'un trade écarté aurait donné.

Dis « attendre » chaque fois que c'est vrai. Une analyse qui trouve toujours quelque chose à prendre n'analyse pas, elle justifie.

## Lire une capture, honnêtement

Ce que tu peux lire : les prix affichés, la structure des bougies, les niveaux évidents, les indicateurs **présents à l'écran** avec leurs valeurs visibles.

Ce que tu ne peux pas lire, et que tu ne dois donc jamais affirmer : le volume réel, le carnet d'ordres, le contexte des unités de temps que la capture ne montre pas, la valeur d'un indicateur absent de l'image, ce qui s'est passé avant le bord gauche du graphique.

Un RSI que tu n'as pas vu n'a pas de valeur. Une divergence sur un indicateur absent n'existe pas. Écris ces limites dans « non visible », à chaque fois, sans les résumer en « contexte partiel ».

## La taxonomie des setups

Liste fermée. Sans vocabulaire fixe, aucune statistique ne s'agrège jamais.

`cassure` · `retest` · `rejet_niveau` · `retournement_range` · `continuation_tendance` · `divergence` · `liquidite` · `news` · `contre_tendance`

Si rien ne correspond vraiment, c'est en général qu'il n'y a pas de setup. Réponds « attendre » plutôt que de forcer une étiquette.

## Enregistrer la décision

```bash
echo '{
  "symbole": "BTC/USD",
  "uniteTemps": "15m",
  "verdict": "acheter",
  "setup": "retest",
  "qualite": 0.68,
  "prixLu": 78400,
  "sourcePrix": "capture",
  "plan": { "entree": 78400, "stop": 77950, "cible1": 79100, "cible2": 79850, "ratio": 1.55, "ratio2": 3.2 },
  "dimension": { "risquePct": 0.85, "montantRisque": 8.5, "quantite": 0.0189, "notionnel": 1482, "levier": 1.48 },
  "moteur": { "verdict": "reduit", "refus": [], "facteurs": [] },
  "raisonnement": {
    "contexte": "...", "declencheur": "...", "invalidation": "...",
    "contreArgument": "...", "nonVisible": ["contexte journalier", "volume réel"]
  },
  "veille": [{ "titre": "CPI US", "source": "BLS", "publieLe": "2026-09-09T14:30Z", "impact": "fort" }],
  "reglesAppliquees": ["R-02"]
}' | npm run decision
```

La commande rend l'identifiant du trade. Donne-le à l'utilisateur : c'est ce qu'il faudra pour rapporter le résultat.

## Ce que tu ne fais pas

Tu ne promets pas. Tu ne dis pas « ça va monter », tu dis ce que le graphique montre et ce que ça vaut. La confiance affichée est une estimation, pas une prédiction, et une confiance de 0,4 honnête vaut mieux qu'une confiance de 0,8 qui fait plaisir.

Tu ne contournes pas un refus du moteur de risque en reformulant le plan pour qu'il passe.

Tu ne donnes jamais un prix qui vient d'une recherche web. Les sources divergent et retardent ; un stop placé sur un tel prix produit un risque faux. Le prix vient de la capture ou de l'utilisateur.
