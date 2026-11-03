import { useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

const ease = "duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]";

export function Button({
  variant = "outline",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "solid" | "ghost" }) {
  const look = {
    outline: "border border-border bg-transparent hover:bg-muted",
    solid: "bg-primary text-primary-foreground hover:opacity-90",
    ghost: "hover:bg-muted",
  }[variant];
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-[background-color,opacity,width,height,padding] ${ease} ${look} ${className}`}
      {...props}
    />
  );
}

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-border bg-card text-card-foreground ${className}`} {...props} />;
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "success" | "warning" | "danger" | "live";
  children: ReactNode;
}) {
  const look = {
    muted: "bg-muted text-muted-foreground",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-destructive/15 text-destructive",
    live: "bg-success/15 text-success",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${look}`}>
      {tone === "live" ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="flux-ping absolute inline-flex h-full w-full rounded-full bg-success/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

export function Field({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 w-full rounded-full border border-border bg-input/30 px-3 text-sm text-foreground placeholder:text-muted-foreground transition-[background-color,width,height,padding] ${ease} ${className}`}
      {...props}
    />
  );
}

export function Kpi({
  title,
  value,
  hint,
  icon,
  tile = "muted",
}: {
  title: ReactNode;
  value: string;
  hint: string;
  icon?: ReactNode;
  tile?: "muted" | "indigo" | "amber" | "emerald" | "rose";
}) {
  const tileBg = {
    muted: "bg-muted text-muted-foreground",
    indigo: "bg-[#3d4fd8] text-white",
    amber: "bg-warning text-black",
    emerald: "bg-success text-black",
    rose: "bg-destructive text-white",
  }[tile];
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{title}</p>
        {icon ? <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${tileBg}`}>{icon}</span> : null}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </Card>
  );
}

export function InlineInfoTooltip({
  text,
  delayDuration = 0,
}: {
  text: string;
  delayDuration?: number;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    if (delayDuration <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delayDuration);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="Aide"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:bg-muted"
      >
        i
      </button>
      {open ? (
        <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-30 w-72 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1.5 text-left text-[11px] leading-4 text-popover-foreground shadow-lg">
          {text}
        </span>
      ) : null}
    </span>
  );
}

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  live?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Previous / next pager under a table; `page` is clamped by the caller. */
export function Pager({ page, pages, total, size, onPage }: {
  page: number;
  pages: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
}) {
  const from = total ? page * size + 1 : 0;
  const to = Math.min(total, (page + 1) * size);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
      <p className="text-xs tabular-nums text-muted-foreground">{from} à {to} sur {total}</p>
      <div className="flex items-center gap-2">
        <Button onClick={() => onPage(page - 1)} disabled={page === 0} className="disabled:opacity-40">Précédent</Button>
        <span className="text-xs tabular-nums text-muted-foreground">Page {page + 1} / {pages}</span>
        <Button onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className="disabled:opacity-40">Suivant</Button>
      </div>
    </nav>
  );
}
