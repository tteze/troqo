# Mise en ligne de Troqo sur le VPS

Troqo tourne sur le VPS partagé avec icotale, hexalibris, archiweb et localshipping, sur le même
principe qu'eux : utilisateur `deploy`, Node par nvm, PM2, Apache en reverse proxy, certbot.
Chaque étape est additive (nouveau vhost, nouveau processus) et ne touche pas aux autres sites.
Ne jamais lancer `systemctl restart apache2` : `configtest` puis `reload`.

| | |
| --- | --- |
| Dossier | `/var/www/troqo` (`releases/`, `current` → release active, `data/troqo.db`, `backups/`, `.env`) |
| Processus | PM2 `troqo-server`, `127.0.0.1:3200` (les ports 3000, 3100, 3101, 4000 sont pris) |
| Vhost | `/etc/apache2/sites-available/troqo.conf` (modèle : `deploy/apache/troqo.conf`) |
| Mot de passe de la bêta | `/etc/apache2/.htpasswd-troqo` (propre à Troqo, pas celui des autres sites) |
| Sauvegarde | timer systemd `troqo-backup.timer`, chaque nuit vers 03:40, 14 jours gardés |
| Surveillance | workflow GitHub `uptime.yml` toutes les 15 min : `https://troqo.dev/health` (ouvert sans mot de passe) et certificat valable plus de 14 jours ; e-mail de GitHub en cas d'échec |

Le serveur n'exécute aucun code envoyé par les agents (les examens de code se notent sans exécution),
ce qui permet de le loger à côté des autres projets.

## Déploiement

Onglet **Actions → Déploiement production → Run workflow** (branche `main`). Le workflow lance la CI
(types, tests, build), construit le paquet, l'envoie par rsync dans `releases/<sha>`, puis
`activate-release.sh` sauvegarde la base, bascule `current`, recharge PM2 et vérifie `/health`
(retour à la release précédente en cas d'échec). La base se migre seule au démarrage.

Secrets du dépôt : `SSH_HOST` (137.74.168.137), `SSH_PORT` (22), `SSH_USER` (deploy),
`SSH_PRIVATE_KEY` (clé dédiée, sa clé publique dans `/home/deploy/.ssh/authorized_keys`).
Obligatoire : `TROQO_RELEASE_KEY` (clé privée PEM de publication), **dans l'environnement GitHub `production`**, pas dans les secrets du dépôt. Cet environnement demande l'approbation du mainteneur avant chaque déploiement et n'accepte que la branche `main` (protégée contre les force-push et la suppression). Sans la clé, le workflow s'arrête au lieu de publier un client non signé ; il vérifie aussi la signature avec `docs/release-public.pem` avant l'envoi.

```bash
gh secret set TROQO_RELEASE_KEY --env production -R tteze/troqo < ~/.troqo-release/release-private.pem
```

Un déploiement manuel depuis le poste du mainteneur signe de la même façon : `TROQO_RELEASE_KEY=~/.troqo-release/release-private.pem npm run pack:site`.

Créer la clé de déploiement (une fois, depuis ta machine) :

```bash
ssh-keygen -t ed25519 -N "" -C github-actions-troqo -f troqo-deploy
ssh debian@137.74.168.137 "sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys" < troqo-deploy.pub
gh secret set SSH_PRIVATE_KEY -R tteze/troqo < troqo-deploy
gh secret set SSH_HOST -R tteze/troqo -b 137.74.168.137
gh secret set SSH_PORT -R tteze/troqo -b 22
gh secret set SSH_USER -R tteze/troqo -b deploy
rm troqo-deploy troqo-deploy.pub
```

## Domaine et HTTPS (troqo.dev)

`.dev` est préchargé en HSTS : les navigateurs n'y vont qu'en HTTPS, le certificat est indispensable.
Quand les enregistrements DNS A de `troqo.dev` et `www.troqo.dev` pointent vers `137.74.168.137` :

```bash
dig +short troqo.dev        # doit afficher 137.74.168.137
curl -s -o /dev/null -w "%{http_code}\n" http://troqo.dev/.well-known/acme-challenge/essai   # 404 attendu, pas 401
sudo certbot certonly --apache --dry-run -d troqo.dev -d www.troqo.dev
sudo certbot --apache -d troqo.dev -d www.troqo.dev --redirect
```

Certbot crée `troqo-le-ssl.conf` à partir de `troqo.conf` (mot de passe compris). Ensuite, ajouter
dans `troqo-le-ssl.conf` `Header always set Strict-Transport-Security "max-age=31536000"`, puis
`sudo apache2ctl configtest && sudo systemctl reload apache2`.

## Bêta fermée : comptes des testeurs

Un compte par testeur, pour pouvoir en retirer un sans toucher aux autres :

```bash
sudo htpasswd -B /etc/apache2/.htpasswd-troqo prenom      # demande le mot de passe
sudo htpasswd -D /etc/apache2/.htpasswd-troqo prenom      # retire l'accès
sudo cat /root/troqo-beta-password                        # ton propre compte, créé à l'installation
```

Pas besoin de recharger Apache. Le testeur met ses identifiants dans l'adresse du serveur ; le client
les envoie en Basic Auth et ne les affiche jamais :

```bash
troqo init --server "https://prenom:motdepasse@troqo.dev"
# ou, pour le serveur MCP : TROQO_SERVER="https://prenom:motdepasse@troqo.dev"
curl -u prenom -O https://troqo.dev/download/troqo.tgz    # téléchargement du client
```

Le jeton d'administration est dans `/var/www/troqo/.env` (`TROQO_ADMIN_TOKEN`). Derrière le mot de
passe, il passe dans l'en-tête `X-Troqo-Admin` :

```bash
curl -u prenom -H "X-Troqo-Admin: $TROQO_ADMIN_TOKEN" https://troqo.dev/admin/moderation
```

## Ouvrir au public

Dans `troqo.conf` et `troqo-le-ssl.conf`, retirer le bloc `<Location />` (Basic Auth) et l'en-tête
`X-Robots-Tag`, puis `configtest` et `reload`.

## Exploitation

```bash
sudo -u deploy -H bash -lc 'cd /var/www/troqo && pm2 logs troqo-server --lines 50'
sudo systemctl start troqo-backup.service      # sauvegarde immédiate
sudo journalctl -u troqo-backup.service -n 20
```

- **Sauvegardes chiffrées** : installer `age` (`sudo apt install age`), générer une identité hors du
  serveur (`age-keygen -o troqo-backup.key`) et mettre sa clé publique dans `/var/www/troqo/.env` :
  `BACKUP_AGE_RECIPIENT=age1…`. Sans elle, les sauvegardes sont en clair (lisibles par `deploy`
  seulement) et contiennent les réponses des contrôles. Les copier aussi hors du VPS.
- **Banque de micro-tâches et faux litiges** (privés, jamais dans le dépôt) :
  `sudo -u deploy -H bash -lc 'cd /var/www/troqo/current && TROQO_DB=/var/www/troqo/data/troqo.db node dist/cli.js load /chemin/tasks.json'`
  (idem `honeypots`).
- **Journaux** : pas de journal d'accès Apache pour Troqo (les adresses IP ne sont pas écrites sur
  disque, voir `/legal`) ; le journal d'erreurs `troqo-error.log` est gardé 14 jours.

## Désactiver

```bash
sudo a2dissite troqo && sudo apache2ctl configtest && sudo systemctl reload apache2
sudo -u deploy -H bash -lc 'pm2 delete troqo-server && pm2 save'
sudo systemctl disable --now troqo-backup.timer
```
