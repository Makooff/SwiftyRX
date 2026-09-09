# Le prompt de départ

Ce fichier contient la demande d'origine, telle qu'elle a été formulée. C'est la spécification du système : quand elle change, les skills et les agents changent avec.

## Le prompt initial

> Tu es sur le Bitcoin en 15 minutes avec un prix actuel à 64 800 $. Donne-moi les meilleurs trades à prendre dessus en market execution avec le poids d'entrée, la direction, le take profit et le stop loss. Chaque trade doit être expliqué sous forme de liste à puces.
>
> Pour chaque trade, tu vas aussi me dire combien je dois prendre en termes de risque, en pourcentage de mon capital, sachant que tu commences avec 1 000 € de capital.
>
> Après chacune de tes positions, je te partagerai le résultat et voici ce que tu feras :
> 1. Mettre à jour ton capital
> 2. Analyser POURQUOI le trade a gagné ou perdu
> 3. En tirer une leçon concrète en 1 phrase

## Ce qui s'y est ajouté

- Le périmètre couvre la **crypto et le forex**, pas seulement le bitcoin.
- Le système doit dire quand c'est une **période pour vendre ou pour acheter**, et repérer les excès de prix. « Attendre » est donc un verdict à part entière.
- L'entrée principale est la **capture d'écran** : l'utilisateur envoie un graphique et demande s'il achète ou s'il vend.
- Le système est **auto-apprenant** : il doit comprendre pourquoi ça n'a pas marché, pourquoi ça a marché, et s'adapter.
- Les règles du projet précédent sont abandonnées.

## Comment chaque point a été traité

| Demande | Où c'est |
|---|---|
| Direction, entrée, TP, SL en liste à puces | `.claude/skills/analyse/SKILL.md`, section « format de sortie » |
| Poids d'entrée et risque en % du capital | `src/risk/sizing.ts` et l'agent `risque` |
| Capital de départ à 1 000 € | `src/settings.ts`, `BORNES.capitalInitial` |
| Mettre à jour le capital | `src/journal/state.ts`, commande `npm run resultat` |
| Analyser pourquoi | la grille en cinq questions, `src/journal/types.ts` |
| Une leçon en une phrase | `src/memory/store.ts`, `leconRecevable` |
| S'adapter | promotion et rétrogradation, `src/memory/rules.ts` |
| Repérer les périodes d'achat et de vente | le verdict « attendre », enregistré et compté au bilan |
| Analyser les marchés | l'agent `veille` et `npm run veille` |

## Deux écarts assumés

**Le prix ne vient pas d'une recherche automatique.** Le prompt initial fournissait un prix dans la phrase. Le système garde ce principe : le prix vient de toi, par capture ou par saisie. Les API de cours sont bloquées depuis une session cloud, et une valeur trouvée sur le web est dispersée entre sources et souvent périmée de plusieurs minutes. Un stop placé sur un prix approximatif produit un risque faux, ce qui est pire que pas de stop du tout.

**Le risque n'est pas libre.** Le prompt demandait que le système décide du risque. Il le fait, entre 0,25 % et 2 % du capital, selon la qualité du setup, l'espérance mesurée, le drawdown et la corrélation. Le plafond de 2 % et les arrêts, eux, sont du code et pas du jugement. Sur 1 000 €, dix pertes d'affilée à 2 % coûtent 18 % du capital, ce dont on revient ; à 5 %, elles en coûtent 40 %, et il faut alors gagner 67 % pour revenir à zéro.

## Pour remplacer ce fichier

Quand tu envoies un nouveau prompt, il remplace ce document. Les écarts avec la version précédente sont ensuite répercutés sur `.claude/skills/` et `.claude/agents/`. C'est le point d'entrée prévu pour ça — inutile de modifier les skills à la main.
