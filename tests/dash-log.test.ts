import { describe, expect, test } from "bun:test";
import { createDashLogger, formatPrettyRecord, sanitizeForLog } from "../src/dash/log.ts";

describe("dash logger", () => {
  test("pretty formatter uses ASCII layout with aligned level", () => {
    const line = formatPrettyRecord({
      time: new Date("2026-11-01T14:57:03.000Z").getTime(),
      level: 30,
      name: "dash",
      msg: "listening http://127.0.0.1:7895",
    }, false);
    expect(line).toContain("INFO ");
    expect(line).toContain("dash  listening http://127.0.0.1:7895");
    expect(/^[0-9]{2}:[0-9]{2}:[0-9]{2} INFO  dash  /.test(line)).toBe(true);
  });

  test("redacts key-like fields and token-like text", () => {
    const cleaned = sanitizeForLog({
      apiKey: "sk-ant-abcdef123456",
      nested: { Authorization: "Bearer secret-token" },
      text: "api_key=abc123",
    }) as Record<string, unknown>;
    expect(cleaned.apiKey).toBe("[REDACTED]");
    expect((cleaned.nested as Record<string, unknown>).Authorization).toBe("[REDACTED]");
    expect(cleaned.text).toBe("[REDACTED]");
  });

  test("LOG_FORMAT=json outputs JSON lines and keeps structured fields", () => {
    const lines: string[] = [];
    const destination = { write(chunk: string) { lines.push(chunk.trim()); } };
    const logger = createDashLogger("dash", {
      env: { LOG_FORMAT: "json", LOG_LEVEL: "debug" },
      isTTY: true,
      destination,
    });
    logger.info({ method: "GET", path: "/api/health", apiKey: "secret" }, "request");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.name).toBe("dash");
    expect(row.level).toBe(30);
    expect(row.msg).toBe("request");
    expect(row.method).toBe("GET");
    expect(row.path).toBe("/api/health");
    expect(row.apiKey).toBe("[REDACTED]");
  });
});

