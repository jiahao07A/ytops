import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { getCoverageMatrix } from "../src/lib/coverage.js";

describe("覆盖矩阵与证据审计", () => {
  it("在没有同步数据时明确标记不可用/部分支持，并保留能力边界", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    try {
      await initializeChannelOperationsConfig(configPath, false);
      const matrix = await getCoverageMatrix(
        configPath,
        "UC1111111111111111111111",
      );
      expect(matrix.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "analytics.breakdown",
            status: "partial",
          }),
          expect.objectContaining({
            capability: "comments.readonly",
            status: "unavailable",
          }),
        ]),
      );
      expect(JSON.stringify(matrix)).not.toContain("access-token");
    } finally {
      await unlink(configPath).catch(() => undefined);
      await rmdir(root).catch(() => undefined);
    }
  });
});
