# Durcissement de l'hôte (kev-homelab)

`infra/host/harden.sh` applique ce que vérifie `orch ops check` (cas de
parité EM40) :
- SSH par clé seulement ;
- connexion root refusée ;
- pare-feu `ufw` actif, avec SSH ouvert au réseau local seulement.

C'est le seul outil d'orch qui demande sudo. Il ne s'exécute jamais tout seul :
aucune routine ne l'appelle.

## En bref

À lancer depuis ton propre terminal sur le homelab, car sudo demande le mot de
passe :

```
cd ~/lab/tools/orch
sudo infra/host/harden.sh check               # état actuel et plan, n'écrit rien
sudo infra/host/harden.sh apply --dry-run     # toutes les vérifications d'apply, ne change rien
sudo infra/host/harden.sh apply               # applique
orch ops check                      # SSH et pare-feu doivent passer au vert
```

Garde ta session SSH ouverte pendant `apply`. Avant de la fermer, ouvre une
nouvelle connexion depuis un autre terminal (`ssh <user>@<host> true`).

## Ce que fait `apply`

```
 vérifications   ──>   SSH   ──>   pare-feu
 (refus = rien         drop-in      ufw : deny incoming,
  n'est modifié)       + sshd -t    SSH depuis le LAN,
                       + restart    réseaux Docker,
                                    enable
```

1. **Vérifications.** Si l'une échoue, rien n'est modifié :
   - le script est lancé en root via sudo, depuis ton compte ;
   - ton compte a au moins une clé dans `~/.ssh/authorized_keys`, faute de quoi
     le mot de passe serait ta seule porte d'entrée ;
   - aucune session SSH ouverte ne vient d'hors du réseau local, sinon `ufw` la
     couperait (`--force` pour passer outre, `--lan CIDR` pour un autre réseau).
2. **SSH.** Écrit `/etc/ssh/sshd_config.d/10-orch-hardening.conf` :

   ```
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin no
   ```

   Puis :
   - valide la configuration avec `sshd -t` ; en cas de refus, il remet le
     fichier précédent et s'arrête sans redémarrer ;
   - redémarre `ssh` (les sessions ouvertes restent) ;
   - vérifie avec `sshd -T` que ces trois valeurs sont bien appliquées.
3. **Pare-feu.**
   - Il configure `ufw default deny incoming` et `allow outgoing`.
   - Il autorise SSH (22/tcp) depuis le réseau local, détecté par la route par
     défaut (`192.168.1.0/24` ici).
   - Il autorise les réseaux Docker par défaut (`172.16.0.0/12`,
     `192.168.16.0/20` et au-delà), pour que les conteneurs joignent toujours les
     services de l'hôte. Le réseau local n'y est pas inclus.
   - Il fait `ufw --force enable` en dernier.

`apply --dry-run` fait tout ce qui précède sans rien modifier :
- les mêmes vérifications (root, clé, sessions) ;
- le vrai `sshd -t`, puis `sshd -T`, sur une copie temporaire de ta config
  avec le drop-in. Il échoue aussi si `sshd_config` n'inclut pas
  `sshd_config.d`, car le drop-in serait alors ignoré ;
- chaque règle passée à `ufw --dry-run`, sans `enable`.

Il vérifie à la fin que ni le drop-in ni `ufw.conf` n'ont bougé.

Le script est idempotent : le relancer ne change rien et ne crée pas de copie
de sauvegarde.

Docker Swarm, qui porte les services `ploydok-*`, continue de fonctionner :
sur un seul nœud, il n'a pas besoin de ses ports réseau (2377, 7946), que le
pare-feu ferme.

## Ce qu'il ne fait pas : les ports publiés par Docker

Docker ouvre ses ports publiés (`ports:` dans un compose) en passant outre
`ufw`. Le script les liste dans `check` sans y toucher. Ils se corrigent dans
chaque projet. Les trois ports d'acme ont été publiés sur localhost le
2026-10-25 (DEV-ORCH-7) :

| Port | Conteneur | Fichier |
|---|---|---|
| 8100 | `acme-core` (service `core`) | `~/lab/perso/marketplace/acme/others/core/@docker/local/compose.yaml` |
| 8180 | `acme-core-mercure` (service `mercure`) | même fichier |
| 3300 | `acme-agent-dev` (service `acme-agent`) | `~/lab/perso/marketplace/acme/others/acme-agent/compose.dev.yml` |

Les fronts tournent sur le homelab et les joignent par `localhost`. Depuis le
Mac, un tunnel SSH : `ssh -N -L 8100:127.0.0.1:8100 -L 8180:127.0.0.1:8180
-L 3300:127.0.0.1:3300 <user>@<host>`.

Pour un nouveau port, deux choix :
- **Utilisé seulement depuis le homelab** : publier sur localhost, par exemple
  `"127.0.0.1:8100:8000"`, puis `docker compose up -d`.
- **Utilisé depuis le Mac ou le téléphone** : le laisser ouvert, et l'ajouter à
  `public_ports` dans `catalog/ops.yaml`, pour que `orch ops check` l'accepte
  en connaissance de cause.

Un port d'origine inconnue (3003 le 2026-10-24) s'identifie avec
`sudo ss -tlnp 'sport = :3003'`.

## Revenir en arrière

```
sudo infra/host/harden.sh rollback
```

`rollback` supprime le drop-in SSH, redémarre `ssh` et désactive `ufw`. Les
règles `ufw` sont gardées mais inactives ; `sudo ufw --force reset` les efface.

Si tu es bloqué dehors, passe par la console physique ou l'écran du homelab,
puis lance la même commande.

## Tests

`tests/harden.test.ts` exécute le script avec de faux `ip`, `ss`, `sshd`,
`systemctl`, `ufw` et `getent` dans le PATH, et une racine temporaire
(`HARDEN_ROOT`). Les tests couvrent :
- les refus (pas root, pas de clé, session hors du réseau local) ;
- le retour arrière quand `sshd -t` refuse ;
- l'arrêt avant le pare-feu si un autre fichier l'emporte dans sshd ;
- l'idempotence et `rollback`.

Aucun test ne touche l'hôte.
