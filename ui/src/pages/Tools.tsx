import { Page } from "../components/Page";
import { Badge, Card, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { harnessLabel, tokens } from "../lib/format";

export function ToolsPage() {
  return (
    <Page crumbs={["orch", "kev", "Outils"]}>
      {(snap) => {
        const rows = snap.lanes.map((lane) => ({
          project: lane.project,
          harness: lane.harness,
          model: lane.model,
          tokens: lane.tokens.input + lane.tokens.output,
          cache: lane.tokens.cacheRead,
          life: lane.life,
        }));
        return (
          <div>
            <PageHead
              title="Matrice d'outils"
              subtitle="Harness et modèle par lane : orch n'expose pas les outils internes des workers."
            />
            <Card className="mx-6 mb-6 overflow-auto">
              {rows.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">Aucune lane, donc aucune cellule harness/modèle.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Projet</th>
                      <th className="px-4 py-2 font-medium">Harness</th>
                      <th className="px-4 py-2 font-medium">Modèle</th>
                      <th className="px-4 py-2 font-medium">Tokens</th>
                      <th className="px-4 py-2 font-medium">Cache</th>
                      <th className="px-4 py-2 font-medium">Cycle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={`${row.project}-${row.harness}-${i}`} className="border-t border-border">
                        <td className="px-4 py-2">{row.project}</td>
                        <td className="px-4 py-2">
                          <span className="flex items-center gap-2">
                            <Persona harness={row.harness} size="sm" />
                            {harnessLabel(row.harness)}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">{row.model}</td>
                        <td className="px-4 py-2 tabular-nums">{tokens(row.tokens)}</td>
                        <td className="px-4 py-2 tabular-nums">{tokens(row.cache)}</td>
                        <td className="px-4 py-2"><Badge>{row.life}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        );
      }}
    </Page>
  );
}
