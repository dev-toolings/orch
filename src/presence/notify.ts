// Messages to the operator's phone, on every channel listed in
// catalog/presence.yaml (`notify`): none, telegram, discord. Each channel is
// tried; any failure is reported after the others were attempted. Request
// URLs carry secrets (bot token, webhook), so errors never quote them.
import { secretEnv } from "../core/env.ts";

export type Channel = "telegram" | "discord";
export type Level = "info" | "ok" | "warn" | "fail";
export const LEVELS: Level[] = ["info", "ok", "warn", "fail"];

// What a message says, apart from how each channel draws it. `title` is the
// outcome as a short sentence; `text` says why and what to do (Markdown);
// `log` is raw output kept monospace; `note` is the small print under a rule
// (next attempt, what to answer). Dates written with when() show in the
// reader's own time zone and language on Discord.
export interface Notice { title: string; text?: string; log?: string; note?: string; level?: Level }

// A plain text becomes a notice: its first line is the title.
export function noticeOf(text: string, extra: Omit<Notice, "title" | "text"> = {}): Notice {
  const [first, ...rest] = text.trim().split("\n");
  return { title: first, text: rest.join("\n").trim() || undefined, ...extra };
}

// R: "dans 6 heures", f: "28 octobre 2026 00:30", in the reader's locale.
export const when = (d: Date | number, style: "R" | "f" | "t" = "f") => `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>`;
export const CHANNELS: Channel[] = ["telegram", "discord"];

const KEYS: Record<Channel, string[]> = { telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], discord: ["DISCORD_WEBHOOK_URL"] };

export const missingKeys = (ch: Channel, env: Record<string, string | undefined>) => KEYS[ch].filter((k) => !env[k]);

async function post(ch: Channel, url: string, body: unknown, fetchImpl: typeof fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(`${ch} unreachable (${(e as Error).name})`);
  }
  if (!res.ok) throw new Error(`${ch} answered ${res.status}`);
}

// One Components V2 container per message (a plain webhook may send
// non-interactive components with ?with_components=true): the accent bar
// carries the level, a heading the outcome, then the explanation, the log
// and, under a rule, the small print. Text displays share a 4000 character
// budget, hence the caps.
const COLORS: Record<Level, number> = { info: 0x5865f2, ok: 0x3ba55c, warn: 0xfaa61a, fail: 0xed4245 };
const LABELS: Record<Level, string> = { info: "info", ok: "ok", warn: "attention", fail: "échec" };
const IS_COMPONENTS_V2 = 1 << 15;
const FENCE = "```";
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 12).trimEnd()}\n[...] coupé`);
const display = (content: string) => ({ type: 10, content });

export function discordPayload(n: Notice) {
  const head = [`### ${clip(n.title.replace(/\s+/g, " "), 200)}`, n.text ? clip(n.text, 1800) : ""].filter(Boolean).join("\n");
  const inner: object[] = [display(head)];
  if (n.log) inner.push(display(`${FENCE}\n${clip(n.log.replaceAll(FENCE, "'''"), 1500)}\n${FENCE}`));
  if (n.note) inner.push({ type: 14, divider: true, spacing: 1 }, display(`-# ${clip(n.note.replace(/\n+/g, " "), 300)}`));
  return {
    username: "Kiba",
    allowed_mentions: { parse: [] },
    flags: IS_COMPONENTS_V2,
    components: [{ type: 17, accent_color: COLORS[n.level ?? "info"], components: inner }],
  };
}

export const withComponents = (url: string) => `${url}${url.includes("?") ? "&" : "?"}with_components=true`;

// Telegram gets plain text, Discord dates turned into local dates.
const plainDates = (s: string) => s.replace(/<t:(\d+):\w>/g, (_, sec) => new Date(Number(sec) * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }));
const plainText = (n: Notice) => plainDates([
  n.level && n.level !== "info" ? `[${LABELS[n.level]}] ${n.title}` : n.title,
  n.text, n.log, n.note,
].filter(Boolean).join("\n"));

export async function notify(message: string | Notice, channels: Channel[], env = secretEnv(), fetchImpl: typeof fetch = fetch): Promise<"sent" | "off"> {
  if (!channels.length) return "off";
  const n = typeof message === "string" ? noticeOf(message) : message;
  const errors: string[] = [];
  for (const ch of channels) {
    const missing = missingKeys(ch, env);
    if (missing.length) { errors.push(`${ch} needs ${missing.join(" and ")} in .env`); continue; }
    try {
      if (ch === "telegram") {
        const base = (env.ORCH_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
        await post(ch, `${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: plainText(n).slice(0, 4000), disable_web_page_preview: true }, fetchImpl);
      } else {
        await post(ch, withComponents(env.DISCORD_WEBHOOK_URL!), discordPayload(n), fetchImpl);
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new Error(`notify: ${errors.join("; ")}`);
  return "sent";
}
