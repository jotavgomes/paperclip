import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docker",
  "docker-compose.yml",
);

function portLines(compose: string): string[] {
  return compose
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s*"[\d.:]+"$/.test(line));
}

describe("docker/docker-compose.yml port bindings", () => {
  it("publishes every port bound to the loopback interface, not every interface", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const lines = portLines(compose);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^-\s*"127\.0\.0\.1:\d+:\d+"$/);
    }
  });
});
