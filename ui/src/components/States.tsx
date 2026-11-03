export function LoadingState() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <p className="text-sm text-muted-foreground">Lecture de l'instantané…</p>
    </div>
  );
}

export function EmptyState({ title, text }: { title?: string; text?: string }) {
  return (
    <div className="px-6 py-10">
      <h2 className="text-lg font-semibold">{title ?? "Rien à afficher"}</h2>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
        {text ?? "Lance une session avec orch presence start, puis reviens ici."}
      </p>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="px-6 py-10">
      <h1 className="text-lg font-semibold">Le tableau n'est pas joignable</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Vérifie que <code className="text-foreground">orch dash</code> tourne sur le port 7894.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
