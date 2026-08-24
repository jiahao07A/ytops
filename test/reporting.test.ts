import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import {
  GoogleReportingProvider,
  syncReporting,
  type ReportingDependencies,
  type ReportingProvider,
} from "../src/lib/reporting.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";

async function fixture(
  run: (input: {
    configPath: string;
    store: MemoryCredentialStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-reporting-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, ".ytops-data", "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  await initializeChannelOperationsConfig(configPath, false);
  await store.set("credential-ref", {
    accessToken: "access-token",
    refreshToken: "refresh-token",
  });
  await mkdir(join(root, ".ytops-data", "oauth"), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      availableChannels: [{ id: channelId, title: "主频道" }],
      selectedChannelId: channelId,
      connections: [
        {
          connectionId: "connection-id",
          channelId,
          title: "主频道",
          status: "connected",
          credentialRef: "credential-ref",
          scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          connectedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    })}\n`,
    "utf8",
  );
  try {
    await run({ configPath, store });
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
    await rmdir(join(root, ".ytops-data")).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("异步 Reporting 数据源", () => {
  it("先记录请求和等待状态，报告就绪后幂等导入", async () => {
    await fixture(async ({ configPath, store }) => {
      let requestCalls = 0;
      let statusCalls = 0;
      let downloadCalls = 0;
      const provider: ReportingProvider = {
        async requestReport() {
          requestCalls += 1;
          return { jobId: "job-1", raw: { requested: true } };
        },
        async getReportStatus() {
          statusCalls += 1;
          return statusCalls === 1
            ? { status: "waiting", raw: { state: "pending" } }
            : { status: "ready", raw: { state: "ready" } };
        },
        async downloadReport() {
          downloadCalls += 1;
          return {
            rows: [{ date: "2026-08-19", views: 5 }],
            raw: { csv: "date,views\n2026-08-19,5" },
            dataAsOf: "2026-08-19T00:00:00.000Z",
          };
        },
      };
      const dependencies: ReportingDependencies = {
        provider,
        credentialStore: store,
      };
      const waiting = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(waiting.state.status).toBe("waiting");
      expect(waiting.state.jobId).toBe("job-1");
      const imported = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(imported.state.status).toBe("imported");
      expect(imported.data.rows).toHaveLength(1);
      const importedAgain = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(importedAgain.data.rows).toHaveLength(1);
      expect(requestCalls).toBe(1);
      expect(statusCalls).toBe(2);
      expect(downloadCalls).toBe(1);
    });
  });

  it("使用 reports 列表中的 downloadUrl 判断 Job 是否就绪", async () => {
    const calls: string[] = [];
    let reportsChecks = 0;
    const provider = new GoogleReportingProvider(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return Response.json({ id: "job-2" });
      }
      if (url.endsWith("/jobs/job-2/reports")) {
        reportsChecks += 1;
        return reportsChecks === 1
          ? Response.json({ reports: [] })
          : Response.json({
              reports: [
                { id: "report-2", downloadUrl: "https://download/report-2" },
              ],
            });
      }
      if (url === "https://download/report-2") {
        return new Response("date,views\n2026-08-19,5\n", { status: 200 });
      }
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 500 },
      );
    });

    const requested = await provider.requestReport({
      accessToken: "access-token",
      channelId,
      reportType: "channel-basic",
    });
    expect(requested.jobId).toBe("job-2");

    const waiting = await provider.getReportStatus({
      accessToken: "access-token",
      channelId,
      jobId: "job-2",
    });
    expect(waiting.status).toBe("waiting");

    const ready = await provider.getReportStatus({
      accessToken: "access-token",
      channelId,
      jobId: "job-2",
    });
    expect(ready.status).toBe("ready");

    const downloaded = await provider.downloadReport({
      accessToken: "access-token",
      channelId,
      jobId: "job-2",
      downloadUrl: ready.downloadUrl,
      dataAsOf: ready.dataAsOf,
    });
    expect(downloaded.rows).toEqual([{ date: "2026-08-19", views: "5" }]);
    expect(reportsChecks).toBe(2);
    expect(calls.some((call) => call.endsWith("/jobs/job-2"))).toBe(false);
  });
});
