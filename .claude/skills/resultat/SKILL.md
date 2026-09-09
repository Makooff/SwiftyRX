---
name: resultat
description: Enregistre le résultat réel d'un trade, met à jour le capital, analyse pourquoi il a gagné ou perdu et en tire une leçon. Use when the user reports how a trade ended. Trigger on "TP touché", "j'ai pris mon stop", "je suis sorti à", "ça a marché", "j'ai perdu", "breakeven", "résultat du trade".
---

# Résultat

L'utilisateur dit ce qui s'est passé. Tu mets à jour le capital, tu comprends pourquoi, tu en tires une leçon quand il y en a une.

## Ce dont tu as besoin

L'identifiant du trade et l'issue. Le prix de sortie si tu l'as : le R réalisé se calcule à partir du plan et du prix de sortie, il ne se saisit pas à la main. Un R saisi est un R arrondi dans le sens qui arrange, et c'est le chiffre sur lequel tout le reste repose.

Si l'utilisateur ne donne pas l'identifiant, `npm run tableau` liste les trades sans résultat.

## La grille, cinq questions

Pose-les vraiment, ne les devine pas. Ce sont ses réponses qui font la valeur du journal.

1. **Le déclencheur prévu s'est-il produit ?** Si non, on est entré sur autre chose que le plan, et le résultat ne dit rien sur le plan.
2. **L'exécution a-t-elle suivi le plan ?** Entrée au prix prévu, stop respecté, sortie où c'était écrit.
3. **Le stop était-il au bon endroit ?** Touché puis prix reparti dans le bon sens sans toi : c'est le placement du stop, pas l'analyse. Ces deux erreurs se corrigent de façon opposée et les confondre fait apprendre l'inverse de ce qu'il faut.
4. **Bon processus ou bon résultat ?** Un trade correct peut perdre. Un trade mauvais peut gagner. Le dire à voix haute est le seul moyen de ne pas répéter le second.
5. **Qu'est-ce qui, connu avant l'entrée, aurait changé la décision ?**

## La commande

```bash
npm run resultat -- --id T-2026-09-09-001 --issue gain --sortie 79100 \
  --declencheur oui --execution oui --stop-serre non --processus bon \
  --etiquette retest_volume \
  --lecon "un retest dont le volume est inférieur à celui de la cassure repart rarement du premier coup"
```

`--issue` vaut `gain`, `perte`, `neutre` ou `non_pris`. Utilise `non_pris` quand le trade a été analysé mais pas exécuté : le capital ne bouge pas, et le journal garde la trace, ce qui permet plus tard de mesurer ce que la prudence a coûté.

Ajoute `--frais` quand tu les connais. Sinon ils sont estimés à 0,1 % du notionnel, et le bilan le signale.

## La leçon

Une leçon nomme une condition observable. Elle se teste, elle peut être contredite, elle change quelque chose au tour suivant.

Bonne : « un retest de cassure en session asiatique sur les majeures forex n'a pas le volume pour tenir ».
Bonne : « quand le stop est sous la mèche plutôt que sous le corps, il survit au balayage ».

Mauvaise : « il faut être plus patient ». Mauvaise : « je dois respecter mon plan ». Ça s'applique à tout, ça ne se vérifie nulle part, et l'écrire donne le sentiment d'avoir appris sans que rien ne change. La commande refuse ces formulations et dit pourquoi.

**Beaucoup de trades n'enseignent rien.** Une perte propre sur un bon setup est le coût normal du métier. Dans ce cas, pas de `--lecon`, et c'est la bonne réponse. Forcer une leçon à chaque trade produit du bruit qui finira par être promu en règle.

**L'étiquette est obligatoire dès qu'il y a une leçon.** Mot court en snake_case, réutilisé à l'identique : c'est lui qui permet de compter les concordances. Avant d'en créer une, regarde `memoire/lecons.jsonl` : si le phénomène a déjà une étiquette, reprends-la. Deux étiquettes voisines pour la même chose empêchent la promotion à jamais.

## Ce que tu dis à l'utilisateur

Le capital avant et après, le R réalisé, et l'analyse en trois lignes maximum.

Deux cas méritent d'être nommés explicitement :

- **Gagné avec un mauvais processus.** Dis-le. C'est le trade qu'on répétera parce qu'il a marché, et c'est celui qui coûtera cher.
- **Perdu avec un bon processus.** Dis-le aussi. Il n'y a rien à corriger, et chercher une correction là où il n'y en a pas mène à changer une méthode qui marchait.

Termine en rappelant `npm run bilan` s'il y a eu une leçon : c'est lui qui verra si elle en promeut une règle.
