import { describe, expect, test } from "bun:test";
import { workerEnv } from "../src/harness/proc.ts";

describe("workerEnv", () => {
  test("passes lane variables and excludes unlisted parent variables", () => {
    const savedSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = "parent-secret";

    try {
      const env = workerEnv({ LANE_REPO: "/repo" });
      expect(env.LANE_REPO).toBe("/repo");
      expect(env.SECRET_TOKEN).toBeUndefined();
      expect(env.ORCH_LANE).toBe("1");
    } finally {
      if (savedSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = savedSecretToken;
    }
  });

  test("rejects an extra ORCH_LANE override", () => {
    expect(() => workerEnv({ ORCH_LANE: "0" })).toThrow(
      "workerEnv: extra key ORCH_LANE is not a LANE_* variable",
    );
  });

  test("rejects other non-LANE extra keys", () => {
    expect(() => workerEnv({ SECRET_TOKEN: "injected" })).toThrow(
      "workerEnv: extra key SECRET_TOKEN is not a LANE_* variable",
    );
  });

  test("rejects values containing a NUL byte", () => {
    expect(() => workerEnv({ LANE_REPO: "/repo\0/secret" })).toThrow(
      "workerEnv: value for LANE_REPO contains a NUL byte",
    );
  });
});
