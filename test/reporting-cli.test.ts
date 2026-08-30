import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const channelId = "UC1111111111111111111111";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8" },
  );
}

interface ReportingSlotFixture {
  reportType: string;
  jobId: string;
  status: "imported" | "failed";
}

/**
 * 以磁盘状态构造方式落盘两种报告类型的 Reporting 同步结果，
 * 供 CLI 接缝断言状态查询按报告类型可查、互不合并。
 */
async function writeReportingSlots(
  root: string,
  fixtures: ReportingSlotFixture[],
): Promise<void> {
  for (const fixture of fixtures) {
    const typeRoot = join(
      root,
      ".ytops-data",
      "reporting",
      channelId,
      fixture.reportType,
    );
    const imported = fixture.status === "imported";
    await mkdir(join(typeRoot, "evidence"), { recursive: true });
    await writeFile(
      join(typeRoot, "latest-state.json"),
      `${JSON.stringify({
        version: 1,
        channelId,
        jobId: fixture.jobId,
        reportId: fixture.jobId,
        reportType: fixture.reportType,
        status: fixture.status,
        coverage: imported ? "complete" : "unavailable",
        updatedAt: "2026-08-19T01:00:00.000Z",
        ...(imported
          ? { importedAt: "2026-08-19T01:00:00.000Z" }
          : {
              error: {
                kind: "not-ready",
                message: "Reporting 报告不可用。",
                retryable: true,
              },
            }),
        ...(imported ? { dataAsOf: "2026-08-19T00:00:00.000Z" } : {}),
        rowCount: imported ? 1 : 0,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(typeRoot, "latest-data.json"),
      `${JSON.stringify({
        version: 1,
        channelId,
        source: "youtube-reporting-api",
        jobId: fixture.jobId,
        reportId: fixture.jobId,
        reportType: fixture.reportType,
        rows: imported ? [{ date: "2026-08-19", views: 5 }] : [],
        evidence: [],
        ...(imported ? { dataAsOf: "2026-08-19T00:00:00.000Z" } : {}),
      })}\n`,
      "utf8",
    );
  }
}

describe("CLI 异步 Reporting 状态", () => {
  it("按报告类型查询时只返回该报告类型的状态与数据", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-reporting-cli-"));
    const configPath = join(root, "config.json");
    try {
      await writeReportingSlots(root, [
        {
          reportType: "channel-basic",
          jobId: "job-basic-1",
          status: "imported",
        },
        {
          reportType: "channel-reach-basic",
          jobId: "job-reach-1",
          status: "failed",
        },
      ]);
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "reporting-status",
        "-c",
        configPath,
        "--channel",
        channelId,
        "--report-type",
        "channel-basic",
      ]);

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        data: {
          state: { reportType: string; status: string; jobId?: string };
          data: { rows: unknown[] };
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.state.reportType).toBe("channel-basic");
      expect(payload.data.state.status).toBe("imported");
      expect(payload.data.state.jobId).toBe("job-basic-1");
      expect(payload.data.data.rows).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("缺省报告类型时列出全部已有状态的报告类型", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-reporting-cli-"));
    const configPath = join(root, "config.json");
    try {
      await writeReportingSlots(root, [
        {
          reportType: "channel-reach-basic",
          jobId: "job-reach-1",
          status: "failed",
        },
        {
          reportType: "channel-basic",
          jobId: "job-basic-1",
          status: "imported",
        },
      ]);
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "reporting-status",
        "-c",
        configPath,
        "--channel",
        channelId,
      ]);

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        data: {
          channelId: string;
          reports: Array<{ state: { reportType: string; status: string } }>;
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.channelId).toBe(channelId);
      expect(
        payload.data.reports.map((report) => report.state.reportType),
      ).toEqual(["channel-basic", "channel-reach-basic"]);
      expect(payload.data.reports.map((report) => report.state.status)).toEqual(
        ["imported", "failed"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
