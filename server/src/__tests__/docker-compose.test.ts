import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards against the crash-loop incident: without a restart policy, `db`
 * stays Exited after a host reboot and `server` comes up before it,
 * crash-looping on ENOTFOUND "db". Also guards the migration/retention
 * flags a fresh onboarding run depends on being set explicitly rather than
 * left to whatever the image defaults to.
 */

const COMPOSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docker",
  "docker-compose.yml",
);

function readCompose(): string {
  return readFileSync(COMPOSE_PATH, "utf8");
}

describe("docker/docker-compose.yml", () => {
  it("gives both db and server a restart policy", () => {
    const compose = readCompose();
    const restartCount = compose.split("restart: unless-stopped").length - 1;
    expect(restartCount).toBe(2);
  });

  it("enables migration auto-apply and disables retention dry-run on server", () => {
    const compose = readCompose();
    expect(compose).toMatch(/PAPERCLIP_MIGRATION_AUTO_APPLY:\s*"true"/);
    expect(compose).toMatch(/PAPERCLIP_EXECUTION_WORKSPACE_RETENTION_DRY_RUN:\s*"false"/);
  });
});
