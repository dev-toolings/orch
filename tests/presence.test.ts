import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordPayload, notify, withComponents } from "../src/presence/notify.ts";
import { loadPresenceConfig, PRESENCE_REPLACED } from "../src/presence/presence.ts";
import { presence } from "../src/presence/cli.ts";

// Notification channels only: the presence lead is retired (orch serve replaced it). No network.
let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-presence-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("notify", () => {
  const env = { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_CHAT_ID: "42", ORCH_TELEGRAM_API: "http://fake", DISCORD_WEBHOOK_URL: "http://discord/api/webhooks/1/tok" };
  const recorder = (status = 200) => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status }); }) as unknown as typeof fetch;
    return { seen, f };
  };

  test("no channel is off; every listed channel gets the message", async () => {
    expect(await notify("x", [], {})).toBe("off");
    const r = recorder(204);
    expect(await notify("routine failed", ["telegram", "discord"], env, r.f)).toBe("sent");
    expect(r.seen.map((s) => s.url)).toEqual(["http://fake/bot123:secret/sendMessage", "http://discord/api/webhooks/1/tok?with_components=true"]);
    expect(r.seen[0].body).toMatchObject({ chat_id: "42", text: "routine failed" });
    expect(r.seen[1].body).toMatchObject({ username: "Kiba", allowed_mentions: { parse: [] }, flags: 1 << 15 });
  });

  test("discord gets one container: level accent, heading, text, fenced log, small print under a rule", () => {
    const n = { title: "backup a échoué", text: "`pg_dump` s'est arrêtée avec le code 1.", log: "connection refused\n```x```", note: "Prochain essai <t:1:R>", level: "fail" as const };
    expect(discordPayload(n).components).toEqual([{
      type: 17, accent_color: 0xed4245, components: [
        { type: 10, content: "### backup a échoué\n`pg_dump` s'est arrêtée avec le code 1." },
        { type: 10, content: "```\nconnection refused\n'''x'''\n```" },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: "-# Prochain essai <t:1:R>" },
      ],
    }]);
    // within the 4000 character budget of text displays, whatever the input
    const long = discordPayload({ title: "t".repeat(300), text: "b".repeat(5000), log: "l".repeat(5000), note: "n".repeat(500) });
    const text = long.components[0].components.map((c) => (c as { content?: string }).content ?? "").join("");
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(withComponents("https://d/api/webhooks/1/t?thread_id=9")).toBe("https://d/api/webhooks/1/t?thread_id=9&with_components=true");
  });

  test("a failing channel does not stop the others; errors name the channel, never a secret", async () => {
    const r = recorder(204);
    const err = await notify("x", ["telegram", "discord"], { DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL }, r.f).catch((e: Error) => e.message);
    expect(err).toBe("notify: telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
    expect(r.seen.length).toBe(1);
    const down = (async () => { throw new TypeError("fetch failed: http://fake/bot123:secret"); }) as unknown as typeof fetch;
    const msg = await notify("x", ["telegram", "discord"], env, down).catch((e: Error) => e.message);
    expect(msg).toBe("notify: telegram unreachable (TypeError); discord unreachable (TypeError)");
    expect(msg).not.toContain("secret");
    await expect(notify("x", ["discord"], env, recorder(401).f)).rejects.toThrow(/discord answered 401/);
  });

  test("presence.yaml takes none, one channel or a list", () => {
    const file = join(root, "notify.yaml");
    const load = (n: string) => { writeFileSync(file, `session: kiba\nworkdir: /tmp\nnotify: ${n}\n`); return loadPresenceConfig(file).notify; };
    expect(load("none")).toEqual([]);
    expect(load("discord")).toEqual(["discord"]);
    expect(load("[telegram, discord, telegram]")).toEqual(["telegram", "discord"]);
    expect(() => load("[sms]")).toThrow(/not sms/);
  });
});

test("the retired presence commands say that orch serve replaced the lead, and start nothing", async () => {
  const out: string[] = [];
  const log = console.log;
  console.log = (line: string) => { out.push(line); };
  try { for (const sub of ["start", "stop", "ensure", "run"]) await presence([sub]); } finally { console.log = log; }
  expect(out).toEqual(Array(4).fill(PRESENCE_REPLACED));
  expect(PRESENCE_REPLACED).toContain("orch-serve.service");
});
