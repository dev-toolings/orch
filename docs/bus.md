# Bus inter-projets

Projets voisins déclarés dans `orch.yaml` à la racine du dépôt. Une boîte aux
lettres par projet sous un dossier commun (`ORCH_BUS_ROOT` ou
`~/lab/.orch-bus/<projet>/inbox/`). Un message est une **demande**, jamais un
ordre : le destinataire le lit (`orch bus list`, injection en début de tour)
et en fait éventuellement une spec qui passe par **sa** gate, son FILES et
son contrôle local. Personne n'écrit dans le dépôt d'un autre ni n'y lance de lane.

```yaml
name: api
bus:
  root: ~/lab/.orch-bus
  keys: ~/.orch/bus-keys
  neighbors:
    - name: front
      path: ../front
      contract: openapi.yaml
      role: consumer
```

`role` est celui du voisin : `consumer` s'il consomme notre contrat, `owner`
s'il le possède.

La clé HMAC-SHA256 de paire est **locale** : `~/.orch/bus-keys/<a>__<b>.key`
(ou `bus.keys` / `ORCH_BUS_KEYS`), dossier `0700`, fichier `0600`. Elle ne
vit plus sous le dossier partagé du bus. Absente ou trop lisible : refus.
Provisionner le voisin :

```text
orch bus key init --to front
orch bus key export --to front --file /tmp/api-front.key
# côté voisin, même fichier :
orch bus key import --to api --file /tmp/api-front.key
```

Si une clé traîne encore sous `<bus root>/keys/`, un avertissement s'affiche ;
importer la copie locale, puis supprimer l'ancienne.

Signature invalide : refus. Le compteur de hops est partagé (les deux
côtés). Au-delà de 2 allers-retours (`hop > 4`), ou si une demande
viserait à modifier le contrat côté owner, ou si un consumer envoie
`--type contract` à l'owner : escalade. `orch bus watch` imprime les
nouveaux messages ; le hook `prompt-submit` les injecte aussi.

```text
orch bus list|status|send|ack|draft|notice|test|watch
orch bus key init|export|import --to <voisin>
```

`notice` envoie « contrat vN disponible » quand le fichier a changé.
`test` parse le contrat côté consumer (YAML/JSON ou types exportés).
`draft <id>` écrit une spec sous `orch dir`/specs/, sans lancer de lane.
