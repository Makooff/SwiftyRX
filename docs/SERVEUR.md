# Faire tourner le bot 24h/24 sur un serveur

Ce guide est en français et suppose que tu n'as jamais administré de serveur.
Compte 30 minutes la première fois.

## Pourquoi un serveur change quelque chose

Sur ton PC, le bot s'arrête quand tu éteins. Trois conséquences, dont une qui
compte vraiment :

- il ne lit plus les actualités — tu rates ce qui se passe la nuit et le
  week-end ;
- le journal de décisions ne se remplit pas — or c'est lui qui débloque tout le
  reste (`npm run tune` ne peut rien recommander sans résultats mesurés) ;
- **tes stops ne sont plus surveillés.** Le stop-loss et le take-profit sont
  vérifiés à l'intérieur d'un cycle. Pas de cycle, pas de vérification. En
  paper trading ça ne coûte rien de réel, mais c'est à régler avant d'envisager
  autre chose.

## Ce que ça coûte

| Poste | Ordre de grandeur |
|---|---|
| VPS | 4 à 6 € / mois |
| Analyse (Anthropic) | selon l'activité — **c'est toi qui fixes le plafond** |

Le second poste est le seul qui puisse déraper, et c'est exactement pourquoi
l'étape 5 ci-dessous n'est pas optionnelle.

## 1. Prendre un VPS

Le plus petit modèle suffit : 2 Go de RAM, 1 vCPU, 20 Go de disque. Chez
Hetzner (CX22), OVH ou Scaleway, c'est la gamme à 4-6 € par mois. Prends
Ubuntu 24.04 LTS comme système, et note l'adresse IP et le mot de passe root
qu'on te donne.

## 2. S'y connecter

Depuis ton PC Windows, ouvre PowerShell et tape (remplace l'adresse) :

```
ssh root@123.45.67.89
```

## 3. Installer Docker

Une seule commande, sur le serveur :

```
curl -fsSL https://get.docker.com | sh
```

## 4. Récupérer le projet

```
git clone https://github.com/Makooff/SwiftyRX.git
cd SwiftyRX
cp .env.example .env
```

## 5. Remplir le .env — et fixer le plafond

```
nano .env
```

Les lignes à remplir au minimum :

```
ANTHROPIC_API_KEY=       ta clé, celle qui fait analyser les nouvelles
LLM_PROVIDER=anthropic   pour activer cette analyse
CONTACT_EMAIL=           ton email, exigé par le régulateur américain
DASHBOARD_PASSWORD=      au moins 12 caractères
DISCORD_WEBHOOK_URL=     pour recevoir les notifications
```

Puis **la ligne qui rend tout ça défendable** :

```
MAX_DAILY_LLM_COST_USD=5
```

Sans elle, il n'y a aucun plafond : le bot analyse tant qu'il y a des
actualités, et personne ne regarde. Avec elle, il s'arrête d'analyser dès que
les 5 $ du jour sont dépensés, te le dit sur Discord une fois, et reprend le
lendemain. Il continue de lire les actualités pendant ce temps — la lecture ne
coûte rien.

Le chiffre est à toi. `npm run tune` ne le changera jamais : c'est une question
de facture, pas de performance, et aucun taux de réussite n'y répond.

Pour enregistrer dans nano : `Ctrl+O`, `Entrée`, puis `Ctrl+X`.

Ajoute enfin les cinq réglages de départ, qui sont ceux qui font que le bot
trouve et analyse quelque chose. Ils sont expliqués un par un dans le fichier
`.env.recommande` à la racine du projet :

```
ENABLED_SOURCES=all
MIN_EVENT_MATERIALITY=0.35
MIN_SIGNAL_SCORE=0.35
ALLOW_MODEL_CHOSEN_ASSET=true
LLM_EFFORT=high
```

(Ne lance pas `npm run tune -- --apply` dans le conteneur : le `.env` que le
conteneur voit vient de `env_file`, et le fichier qu'il modifierait
disparaîtrait avec le conteneur. Sur le serveur, c'est nano qui fait le
travail.)

## 6. Démarrer

```
docker compose up -d --build agent
```

C'est tout. Le bot tourne, et il redémarrera tout seul après un redémarrage du
serveur ou un plantage.

Pour voir ce qu'il fait :

```
docker compose logs -f agent
```

## 7. Voir le tableau de bord depuis ton PC

Le dashboard n'est **pas** exposé sur internet, volontairement : un VPS a une
adresse publique, et publier le port mettrait ton portefeuille en ligne
derrière un simple mot de passe.

Depuis PowerShell sur ton PC :

```
ssh -L 3000:127.0.0.1:3000 root@123.45.67.89
```

Laisse cette fenêtre ouverte, puis va sur http://127.0.0.1:3000 dans ton
navigateur.

## Mettre à jour

```
cd SwiftyRX
git pull
docker compose up -d --build agent
```

Le journal de décisions et le portefeuille survivent : ils sont dans un volume
Docker (`agent_data`), pas dans l'image.

## Arrêter

```
docker compose stop agent
```

## Si quelque chose ne va pas

| Symptôme | Où regarder |
|---|---|
| Le conteneur redémarre en boucle | `docker compose logs agent` — presque toujours une ligne du `.env` |
| Le bot tourne mais ne lit rien | `ENABLED_SOURCES=all` est-il bien mis ? |
| Plus aucune analyse | plafond du jour atteint — le dashboard et Discord le disent |
| Diagnostic complet | `docker compose run --rm agent npm run doctor` |
