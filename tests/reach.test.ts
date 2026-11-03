import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReach } from "../src/lanes/reach.ts";

let wt: string;
beforeAll(() => {
  wt = mkdtempSync(join(tmpdir(), "reach-test-"));
  writeFileSync(join(wt, "Makefile"), [
    "COMPOSE := docker compose -f @docker/local/compose.yaml -f @docker/local/compose.dev.yaml",
    "test:\n\t@$(COMPOSE) exec -T core php vendor/bin/phpunit $(TEST_ARGS)",
    "wait:\n\t@for i in 1 2; do if $(COMPOSE) exec -T core php -r 'exit(0);'; then exit 0; fi; done",
    "fresh:\n\t$(COMPOSE) run --rm core php vendor/bin/phpunit",
    "unit:\n\tbun test",
    "",
  ].join("\n"));
  writeFileSync(join(wt, "package.json"), JSON.stringify({ scripts: { test: "docker exec api bun test", unit: "bun test" } }));
  writeFileSync(join(wt, "composer.json"), JSON.stringify({ scripts: { test: ["@php -v", "kubectl -n app exec deploy/api -- phpunit"] } }));
});
afterAll(() => rmSync(wt, { recursive: true, force: true }));

describe("verifyReach", () => {
  test("a command entering a running container does not reach the worktree", () => {
    for (const cmd of [
      "docker exec api phpunit",
      "docker compose -f a.yaml -f b.yaml exec -T core phpunit",
      "docker-compose --project-name x exec core phpunit",
      "sudo docker compose exec core phpunit",
      "podman exec api phpunit",
      "kubectl --namespace app exec deploy/api -- phpunit",
      "true && docker compose exec core phpunit",
      "sudo -u root docker exec api phpunit",
      "timeout 60 env CI=1 docker exec api phpunit",
      "sh -c 'docker compose exec core phpunit'",
      "if docker compose exec -T core php -r 'exit(0);'; then echo up; fi",
    ]) expect(verifyReach(cmd, wt)).toStartWith("outside the worktree: ");
  });

  test("wrappers are followed: make targets, package.json and composer.json scripts", () => {
    expect(verifyReach(`make test TEST_ARGS="--filter 'PurgeStale|MarketListingPurge'"`, wt)).toContain("`make test");
    expect(verifyReach("make wait", wt)).toStartWith("outside the worktree: ");
    expect(verifyReach("bun run test", wt)).toContain("docker exec api bun test");
    expect(verifyReach("npm test", wt)).toStartWith("outside the worktree: ");
    expect(verifyReach("composer test", wt)).toContain("kubectl -n app exec");
  });

  test("commands that run from the worktree reach it", () => {
    for (const cmd of [
      "bun test tests/a.test.ts", "make fresh", "make unit", "bun run unit", "test -f a.txt",
      "docker compose -f @docker/local/compose.yaml run --rm core phpunit",
      "docker run --rm php:8.4 php -v",
      "echo exec", "grep -r 'docker compose exec' docs",
    ]) expect(verifyReach(cmd, wt)).toBeNull();
  });

  test("a container pointed at the worktree on purpose is trusted, a compose file inside it is not", () => {
    expect(verifyReach('docker compose exec -w "$LANE_WORKTREE" core phpunit', wt)).toBeNull();
    expect(verifyReach(`docker exec -w ${wt} api phpunit`, wt)).toBeNull();
    expect(verifyReach(`docker compose -f ${wt}/compose.yaml exec core phpunit`, wt)).toStartWith("outside the worktree: ");
  });
});
