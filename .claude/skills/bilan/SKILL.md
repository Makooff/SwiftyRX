---
name: bilan
description: Fait le point sur les performances, promeut les leçons en règles, retire celles que les faits ne soutiennent plus. Use weekly, after a losing streak, or when asked how things are going. Trigger on bilan, statistiques, "où j'en suis", "ça donne quoi", performance, revue, "j'ai appris quoi".
---

# Bilan

Le moment où la mémoire bouge. À faire une fois par semaine, après une série de pertes, et chaque fois que le moteur impose un bilan pour cause de drawdown.

```
npm run bilan
```

`npm run bilan -- --sec` fait tourner l'analyse sans rien écrire, pour voir ce qui changerait.

## Ce que la commande fait

Dans cet ordre, et l'ordre compte :

1. Met à jour le suivi des règles avec les trades dénoués depuis la dernière fois.
2. **Retire** les règles que les faits ne soutiennent plus.
3. **Promeut** les groupes de trois leçons concordantes.

Les retraits passent avant les promotions : dans l'autre sens, le plafond de douze règles actives serait occupé par des règles périmées et rien de neuf ne pourrait naître.

Puis `memoire/regles.md` et `memoire/setups.md` sont régénérés.

## Comment lire les chiffres

**Sous 30 trades dénoués, aucun chiffre ne décide de rien.** La commande le rappelle. Ce n'est pas une précaution de style : sur vingt trades, une différence de dix points de taux de réussite entre deux setups est parfaitement compatible avec le hasard.

**L'espérance nette est le seul chiffre qui compte.** Elle retire les frais. Une espérance positive avant frais et nulle après veut dire que ces trades ne rapportent rien et déplacent de l'argent vers le broker. La commande le signale explicitement quand ça arrive, parce que c'est invisible sur un taux de réussite.

**Le taux de réussite ne dit presque rien seul.** 70 % de réussite avec des gains à 0,5 R et des pertes à 1 R perd de l'argent. Regarde l'espérance, pas le pourcentage.

**La pire série** dit si le dimensionnement tient. Six pertes d'affilée à 2 % coûtent 12 % du capital. Si la pire série observée approche de ce que les bornes supportent, c'est le risque par trade qu'il faut baisser, pas la méthode qu'il faut changer.

**Les gains issus d'un mauvais processus** sont la ligne la plus utile du rapport. Ce sont les trades qu'on répétera parce qu'ils ont marché.

## Le prix de la prudence

Le rapport compte les trades écartés et, parmi eux, ceux dont on connaît l'issue après coup. C'est l'angle mort du système : on ne saura jamais ce qu'ont donné les trades refusés, sauf si l'utilisateur le rapporte.

Encourage-le à le faire de temps en temps. Un système qui refuse beaucoup et ne mesure jamais ce que ses refus coûtent finit par se croire prudent alors qu'il est seulement inactif.

## Quand une règle est promue

Explique-la en une phrase, avec ses preuves et son étiquette de confiance. Rappelle qu'elle ne peut que refuser ou réduire, jamais autoriser.

## Quand rien n'est promu

C'est le cas normal, surtout au début. Dis combien de leçons existent et combien il en faut. Si un groupe est à une leçon du seuil, nomme-le : c'est ce qu'il faut surveiller au prochain trade de ce type.

## Quand le plafond de règles est atteint

Douze règles actives, c'est déjà beaucoup : presque toute configuration en déclenche une et le système n'analyse plus, il refuse. Propose alors à l'utilisateur d'arbitrer, en montrant les règles les moins étayées — celles dont l'échantillon est le plus petit et l'espérance la moins nette.

## Le ton

Dis les mauvais chiffres comme les bons. Un bilan qui arrondit dans le bon sens ne sert à rien, et c'est précisément le fichier dont l'utilité dépend de son honnêteté.

Quand le compte perd, dis-le, dis de combien, et dis ce que les données permettent d'en conclure — souvent : rien encore, l'échantillon est trop petit. C'est une réponse valable et c'est plus utile qu'une explication inventée.
