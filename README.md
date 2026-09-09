# Copilote de trading

Un copilote pour trader la crypto et le forex à la main. Tu envoies une capture de graphique ; il répond **ACHETER**, **VENDRE** ou **ATTENDRE**, avec l'entrée, le stop, les cibles et le pourcentage de capital à risquer. Tu lui dis ce qui s'est passé ; le capital se met à jour, le trade est analysé, et une leçon en sort quand il y en a une. Trois leçons concordantes deviennent une règle qui filtre les analyses suivantes.

Le capital de départ est de 1 000 €.

> **Aucun ordre n'est passé depuis ce dépôt.** Il n'y a pas de connexion à un courtier et il n'y en aura pas. Tu exécutes toi-même, et la décision finale est la tienne.

---

## La boucle

```
tu envoies une capture
        ↓
  veille    ce qui bouge la paire, sourcé et daté
  mémoire   les règles apprises qui s'appliquent
        ↓
  Claude lit le graphique : setup, niveaux, qualité de 0 à 1
        ↓
  risque    le % à risquer, la taille, ou un refus motivé   ← code, pas jugement
        ↓
  VERDICT + écriture au journal
        ↓
  tu rapportes le résultat
        ↓
  capital · grille du pourquoi · leçon
        ↓
  3 leçons concordantes → une règle
```

## Démarrer

```bash
npm install
npm run simulation      # vérifie que tout marche, sans toucher à tes données
npm run tableau         # l'état du compte, dans le terminal
npm run tableau:html    # le même écran en page web, à ouvrir dans un navigateur
```

`tableau:html` écrit `journal/tableau.html` : une page unique, sans serveur, qui se régénère à partir du journal. Tant que le journal est vide, elle montre un jeu d'exemple **marqué comme tel** — une coquille vide ne dirait pas à quoi sert l'écran.

Puis, dans Claude Code, envoie une capture de graphique et demande. Les skills se déclenchent seules.

## Les commandes

| Commande | Ce qu'elle fait |
|---|---|
| `npm run tableau` | Capital, positions, statistiques, règles, dans le terminal |
| `npm run tableau:html` | La même chose en page web, dans `journal/tableau.html` |
| `npm run contexte` | Ce que la mémoire sait, avant une analyse |
| `npm run risque` | Le verdict du moteur, avec toutes ses vérifications |
| `npm run decision` | Enregistre une analyse au journal |
| `npm run resultat` | Enregistre ce qui s'est passé, met à jour le capital |
| `npm run bilan` | Promeut et retire les règles, régénère les vues |
| `npm run veille` | Flux des banques centrales — réseau requis |
| `npm run simulation` | Vérification de bout en bout |

Exemple :

```bash
npm run risque -- --paire BTC/USD --sens achat --setup retest \
  --entree 78400 --stop 77950 --cible 79100 --qualite 0.68
```

---

## Le modèle propose, le code dispose

Le moteur de risque ne lit ni la capture d'écran ni le raisonnement. Il reçoit une note de qualité, des prix, l'état du compte, et il applique des règles dans un ordre fixe. Un modèle très convaincu et un modèle hésitant obtiennent la même réponse pour les mêmes nombres.

**Le risque n'est pas figé, il est borné.** Claude choisit librement entre 0,25 % et 2 % du capital selon la qualité du setup, l'espérance mesurée de ce setup, le drawdown en cours et la corrélation avec les positions ouvertes. Ce qu'il ne peut pas faire, c'est dépasser le plafond ni lever un arrêt.

Le plafond de 2 % est le chiffre le plus important du projet. Sur 1 000 €, dix pertes d'affilée à 2 % coûtent environ 18 % du capital, ce dont on revient. À 5 %, les mêmes dix pertes en coûtent 40 %, et il faut alors gagner 67 % pour revenir à zéro. Cette asymétrie entre perdre et récupérer est toute la raison d'être du plafond.

Les arrêts sont du code : journée à −4 %, semaine à −8 %, drawdown à 15 %, pause après trois pertes d'affilée. Tout est dans [`src/settings.ts`](src/settings.ts), en clair, modifiable en une ligne — à froid, pas pendant un trade.

**Rien n'augmente jamais la mise.** Tous les facteurs de calcul sont inférieurs ou égaux à 1. Une série de gains n'a aucun chemin vers une position plus grosse. C'est délibérément asymétrique : l'inflation de confiance après trois gains est aussi banale que la vengeance après trois pertes, et elle coûte plus cher parce qu'elle frappe avec une taille plus grosse.

## Le journal dit la vérité

Chaque décision est écrite, **y compris les « attendre » et les trades refusés**. Sans elles, le journal ne garde que ce qu'on a tenté, et le bilan flatte forcément le système. C'est du biais du survivant et c'est la façon la plus courante de croire qu'une méthode marche.

Le format est du JSON Lines en ajout seul. Un résultat, connu des heures après la décision, s'écrit sur sa propre ligne ; la lecture le replie sur la décision qu'il complète. Une correction supersède au lieu d'effacer, et les deux versions restent dans le fichier. On ne peut donc pas nettoyer le journal après coup — c'est voulu.

Le bilan mesure aussi le **prix de la prudence** : combien de trades ont été écartés, et parmi eux combien auraient gagné. Tant que tu ne rapportes pas ce qu'ils ont donné, le système dit qu'il ne sait pas, plutôt que de compter chaque refus comme un bon choix.

## Comment il apprend

Une **leçon** est une observation sur un trade ; elle n'agit sur rien. Une **règle** filtre les analyses suivantes, et il faut trois leçons concordantes pour en produire une.

Une leçon doit nommer une condition observable. « Un retest de cassure en session asiatique sur les majeures n'a pas le volume pour tenir » se teste et peut être contredite. « Il faut être plus patient » s'applique à tout et ne se vérifie nulle part : le système refuse ce genre de phrase.

Les garde-fous du mécanisme, parce que c'est là qu'un système comme celui-ci se trompe :

- Une règle **ne peut que refuser ou réduire**, jamais autoriser ni agrandir.
- Chaque statistique porte son échantillon : `indicatif` sous 10 trades, `émergent` sous 20, `établi` au-delà. Sur trois trades on mesure du bruit.
- Aucun réglage numérique ne bouge sous 30 résultats.
- Une règle meurt quand trois trades qu'elle a écartés auraient gagné, ou quand l'espérance du schéma qu'elle interdit redevient positive sur vingt observations. Les régimes de marché changent.
- Au-delà de douze règles actives, le bilan force un arbitrage. Un système qui accumule des filtres finit par ne plus rien laisser passer : il aura l'air d'avoir appris alors qu'il aura seulement appris à refuser.

La grille d'analyse tient en cinq questions, et la quatrième distingue le processus du résultat. Un bon trade peut perdre, un mauvais peut gagner, et confondre les deux fait apprendre l'inverse de ce qu'il faut.

## D'où vient le prix

De ta capture, ou de ta saisie. Jamais du web.

Les API de cours — Binance, Coinbase, Kraken, Yahoo, les fournisseurs forex — sont bloquées par le proxy réseau d'une session Claude en cloud. Et une recherche web renvoie des cours dispersés entre sources et souvent en retard de plusieurs minutes : un stop placé sur une telle valeur produit un risque faux, ce qui est pire que pas de stop.

La recherche web sert au contexte : calendrier macro, décisions de banques centrales, actualité. Chaque élément est daté et sourcé. `npm run veille` interroge en plus les flux officiels de la BCE, de la Fed et du BLS, quand le réseau le permet — donc sur ta machine, pas dans une session cloud.

Tout texte récupéré est clôturé avant d'atteindre un modèle. Une dépêche n'est pas une instruction, et une page web peut contenir des consignes qui visent le modèle qui la lit.

---

## Vérifier

```bash
npm run typecheck && npm run lint && npm test   # 107 tests, hors ligne
npm run simulation                              # 17 vérifications de bout en bout
```

La simulation rejoue une séquence écrite dans un dossier temporaire et vérifie que le capital suit, que les arrêts se déclenchent, qu'une règle naît de trois leçons puis meurt quand les faits la contredisent, et que les « attendre » laissent une trace. Aucune donnée réelle : les prix sont en dur, et le point n'est pas de savoir si la stratégie gagne — dans ce scénario elle perd, exprès — mais si la mécanique dit la vérité sur ce qui s'est passé.

## Limites

**Ce système ne prédit pas les prix.** Aucun système ne le fait. Ce qu'il apporte est réel mais différent : une taille de position calculée au lieu d'estimée, un refus quand le contexte ne s'y prête pas, une trace de chaque décision, et une mémoire qui se corrige avec des preuves plutôt qu'avec des impressions.

**Une analyse ne vaut que ce que vaut la capture.** Sans le contexte des unités de temps supérieures, sans le volume réel, sans le carnet d'ordres, la lecture est partielle. Le format l'écrit à chaque fois dans sa ligne « non visible », et un indicateur absent de l'image n'a pas de valeur.

**Sous 30 trades, aucune statistique ici n'est significative.** Le système affiche `indicatif` plutôt que de faire semblant.

**Les frais pèsent lourd sur un petit compte.** Sur un trade court de 0,3 % avec 0,1 % de frais aller-retour, un tiers du gain part en frais. Le bilan les compte et affiche l'espérance nette, parce qu'un journal qui les ignore montre une performance qui n'existe pas.

## Historique

Ce dépôt contenait auparavant un agent autonome pour actions américaines : ingestion de dépêches, détection d'événements, scoring, paper trading, backtest. Son moteur de risque, son journal en ajout seul et son ingestion officielle ont été repris ici ; le reste a été retiré.

L'état d'avant est intact dans l'historique git, au commit `aeab2bb`, qui est aussi le dernier commit de `main` avant cette réécriture. Rien n'est perdu.

```bash
git show aeab2bb --stat          # ce que contenait le dépôt
git checkout aeab2bb -- src/     # récupérer un fichier au besoin
```
