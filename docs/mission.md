# Missions

`lane batch --mission <fichier>` (aussi `orch lane batch`) exécute un graphe de
specs. Chaque nœud est une lane normale : même `laneRun`, même gate
(`VERIFY`, FILES, revue si risque). Le worker ne reçoit que sa spec.

Le coût estimé est calculé et réservé avant le premier nœud (suivi
informatif, pas de blocage sur `spend.daily_usd`). `ORCH_PAUSE` est relu entre
les nœuds. Premier blocage : arrêt, dépendances non lancées, code de sortie
non nul.

```yaml
name: demo
concurrency: 2
nodes:
  - id: types
    spec: specs/types.txt
  - id: api
    spec: specs/api.txt
    needs: [types]
```

Exemple : `docs/examples/mission-demo.yaml`.
