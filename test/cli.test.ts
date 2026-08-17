import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    {
      encoding: "utf8",
    },
  );
}

describe("CLI JSON error contract", () => {
  it.each([
    ["missing mandatory option", ["--json", "captions", "fetch"]],
    ["unknown option", ["--json", "--not-a-real-option"]],
  ])("serializes %s as a single JSON error payload", (_scenario, args) => {
    const result = runCli(args);

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });

  it.each([
    ["help", ["--json", "--help"], "Usage: ytops"],
    ["version", ["--json", "--version"], "0.1.0"],
  ])(
    "serializes %s output without mixing human-readable stdout",
    (_scenario, args, expectedOutput) => {
      const result = runCli(args);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          output: expect.stringContaining(expectedOutput),
        },
      });
    },
  );
});
