import { Page } from "../components/Page";
import { Card, PageHead } from "../components/ui";
import { EmptyState } from "../components/States";

export function SkillsPage() {
  return (
    <Page crumbs={["orch", "kev", "Compétences"]}>
      {(snap) => (
        <div>
          <PageHead title="Compétences" subtitle="Skills du dépôt (.agents/skills), nom et description seulement." />
          {snap.skills.length === 0 ? (
            <EmptyState
              title="Catalogue vide"
              text="Aucune compétence n'est publiée dans ce dépôt. Ajoute un dossier sous .agents/skills avec un SKILL.md."
            />
          ) : (
            <ul className="space-y-2 px-6 pb-6">
              {snap.skills.map((skill) => (
                <li key={skill.id}>
                  <Card className="px-4 py-3">
                    <p className="font-medium">{skill.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{skill.description || "Sans description."}</p>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
