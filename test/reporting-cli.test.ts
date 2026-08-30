import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli-harness.js";

const channelId = "UC1111111111111111111111";

interface ReportingSlotFixture {
  reportType: string;
  jobId: string;
  status: "imported" | "failed";
  rows: Array<Record<string, string | number>>;
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
        rowCount: imported ? fixture.rows.length : 0,
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
        rows: imported ? fixture.rows : [],
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
          rows: [{ date: "2026-08-19", views: 5 }],
        },
        {
          reportType: "channel-reach-basic",
          jobId: "job-reach-1",
          status: "failed",
          rows: [],
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
          rows: [],
        },
        {
          reportType: "channel-basic",
          jobId: "job-basic-1",
          status: "imported",
          rows: [{ date: "2026-08-19", views: 5 }],
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

describe("CLI 异步 Reporting 读取", () => {
  it("读取 reach 报表返回规范化的曝光行，--video 过滤后只留该视频", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-reporting-read-"));
    const configPath = join(root, "config.json");
    try {
      await writeReportingSlots(root, [
        {
          reportType: "channel_reach_basic_a1",
          jobId: "job-reach-1",
          status: "imported",
          rows: [
            {
              date: "2026-08-19",
              channel_id: channelId,
              video_id: "v1",
              video_thumbnail_impressions: "100",
              video_thumbnail_impressions_ctr: "0.0523",
            },
            {
              date: "2026-08-19",
              channel_id: channelId,
              video_id: "v2",
              video_thumbnail_impressions: "40",
              video_thumbnail_impressions_ctr: "5.25%",
            },
          ],
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

      const filtered = runCli([
        "--json",
        "ops",
        "channel",
        "reporting-read",
        "-c",
        configPath,
        "--channel",
        channelId,
        "--report-type",
        "channel_reach_basic_a1",
        "--video",
        "v2",
      ]);
      expect(filtered.status).toBe(0);
      const filteredPayload = JSON.parse(filtered.stdout) as {
        ok: boolean;
        data: {
          reportType: string;
          status: string;
          dataAsOf?: string;
          rows: Array<Record<string, string>>;
        };
      };
      expect(filteredPayload.ok).toBe(true);
      expect(filteredPayload.data.reportType).toBe("channel_reach_basic_a1");
      expect(filteredPayload.data.status).toBe("imported");
      expect(filteredPayload.data.dataAsOf).toBe("2026-08-19T00:00:00.000Z");
      expect(filteredPayload.data.rows).toEqual([
        {
          date: "2026-08-19",
          channelId: "UC1111111111111111111111",
          videoId: "v2",
          impressions: "40",
          ctr: "5.25%",
        },
      ]);

      const unfiltered = runCli([
        "--json",
        "ops",
        "channel",
        "reporting-read",
        "-c",
        configPath,
        "--channel",
        channelId,
        "--report-type",
        "channel_reach_basic_a1",
      ]);
      expect(unfiltered.status).toBe(0);
      const unfilteredPayload = JSON.parse(unfiltered.stdout) as {
        data: { rows: unknown[] };
      };
      expect(unfilteredPayload.data.rows).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("读取未登记报告类型时原样透传已保存行", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-reporting-read-"));
    const configPath = join(root, "config.json");
    try {
      await writeReportingSlots(root, [
        {
          reportType: "channel-basic",
          jobId: "job-basic-1",
          status: "imported",
          rows: [{ date: "2026-08-19", views: 5 }],
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
        "reporting-read",
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
        data: { rows: Array<Record<string, string | number>> };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.rows).toEqual([{ date: "2026-08-19", views: 5 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
