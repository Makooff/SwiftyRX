# Copilote de trading

Crypto et forex. L'utilisateur envoie une capture de graphique ou nomme une paire ; le système rend **ACHETER, VENDRE ou ATTENDRE** avec entrée, stop, cibles et pourcentage de risque. L'utilisateur rapporte le résultat ; le capital, le journal et la mémoire se mettent à jour.

Aucun ordre n'est passé par ce dépôt. L'exécution est manuelle et la décision finale appartient à l'utilisateur.

## Qui décide quoi

| Décision | Qui |
|---|---|
| Lire le graphique, nommer le setup, placer les niveaux | Claude |
| Noter la qualité du setup entre 0 et 1 | Claude |
| Trouver les infos à impact | agent `veille` |
| Choisir le % de risque et la taille | agent `risque` → `src/risk/` |
| Refuser un trade, arrêter la journée | code seul, non négociable |
| Écrire la leçon, promouvoir une règle | agent `memoire` → `npm run bilan` |

Le modèle propose, le code dispose. Le moteur de risque ne lit ni la capture ni le raisonnement : il reçoit des nombres. Un modèle convaincu et un modèle hésitant obtiennent la même réponse pour les mêmes nombres.

## Les commandes

```
npm run tableau      l'état du compte, dans le terminal
npm run tableau:html la même page en HTML, dans journal/tableau.html
npm run contexte     règles applicables et stats, avant une analyse
npm run risque       le verdict du moteur, avec toutes ses vérifications
npm run decision     enregistre une analyse au journal
npm run resultat     enregistre ce qui s'est passé, met à jour le capital
npm run bilan        promeut et retire les règles, régénère les vues
npm run veille       flux des banques centrales (réseau requis)
npm run simulation   la vérification de bout en bout
```

## Règles d'exploitation

**Le prix vient de la capture ou de l'utilisateur, jamais du web.** Les sources divergent et retardent. Un stop placé sur un prix approximatif produit un risque faux.

**Ne jamais affirmer ce qui n'est pas à l'écran.** Volume réel, carnet d'ordres, unités de temps supérieures, valeur d'un indicateur absent de l'image. La ligne « non visible » du format le dit à chaque analyse.

**Toute décision est enregistrée**, « attendre » et refus compris. Sans les décisions sans trade, le journal ne garde que ce qu'on a tenté et le bilan flatte le système.

**Toujours afficher la taille de l'échantillon.** « 67 % » sur trois trades et sur quarante sont deux affirmations différentes. Étiquettes : `indicatif` sous 10, `émergent` sous 20, `établi` au-delà.

**Une règle apprise ne peut que refuser ou réduire.** Jamais autoriser, jamais agrandir. Une mémoire qui peut lever ses propres garde-fous le fera.

**Rien n'augmente la mise.** Ni une série de gains, ni une forte conviction. Tous les facteurs de `risqueRecommande` sont inférieurs ou égaux à 1, par construction.

**Une leçon nomme une condition observable.** « Il faut être plus patient » n'en est pas une. Beaucoup de trades n'enseignent rien, et une perte propre sur un bon setup est le coût normal du métier.

**Ne pas contourner un refus.** Ni en rapprochant le stop, ni en reformulant le plan. Un plafond contournable n'est pas un plafond.

## Où sont les choses

```
src/settings.ts     les bornes, en dur — tout ce qui décide combien d'argent est en jeu
src/risk/           moteur, taille, classification des paires
src/journal/        journal JSONL, capital, statistiques
src/memory/         leçons, promotion et rétrogradation des règles
src/watch/          flux RSS, clôture du texte externe
.claude/agents/     veille, risque, memoire
.claude/skills/     analyse, resultat, bilan
journal/            capital.json, trades.jsonl
memoire/            lecons.jsonl, regles.json, et les vues .md régénérées
reference/          le prompt source
```

Le markdown de `memoire/` est régénéré par `npm run bilan`, jamais lu par le code. La source de vérité est le JSON.

## Économie de contexte

Lecture lourde, exploration, mapping → sous-agent : garder la conclusion, pas les extraits. Ne pas relire un fichier déjà édité. Ne pas relancer une recherche déjà déléguée.

## Sortie

Réponses courtes. Zéro prose de remplissage. Pas de résumé sauf demandé. Commentaire de code seulement pour un WHY non évident.

Dire les mauvais chiffres comme les bons. Ne pas promettre. Une confiance de 0,4 honnête vaut mieux qu'une confiance de 0,8 qui fait plaisir.

## Commits

`feat|fix|refactor: description`, en français.

Les lignes d'attribution sont imposées par le harnais Claude Code et priment sur cette convention quand les deux se contredisent.
