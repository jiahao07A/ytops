import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import {
  GoogleReportingProvider,
  getReportingStatus,
  syncReporting,
  type ReportingDependencies,
  type ReportingProvider,
  type ReportingRow,
} from "../src/lib/reporting.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";

interface ScriptedReportType {
  reportType: string;
  jobId: string;
  rows: ReportingRow[];
}

interface ScriptedReportTypeCalls {
  request: number;
  status: number;
  download: number;
}

/**
 * 同步任务假 provider：按报告类型脚本化返回不同的 Job 与数据行，
 * 并记录每类同步阶段的调用次数，用于断言幂等与短路语义。
 */
function createScriptedReportingProvider(reportTypes: ScriptedReportType[]): {
  provider: ReportingProvider;
  calls: Map<string, ScriptedReportTypeCalls>;
} {
  const calls = new Map<string, ScriptedReportTypeCalls>(
    reportTypes.map((scripted) => [
      scripted.reportType,
      { request: 0, status: 0, download: 0 },
    ]),
  );
  const provider: ReportingProvider = {
    async requestReport(input) {
      const scripted = reportTypes.find(
        (entry) => entry.reportType === input.reportType,
      );
      if (scripted === undefined) {
        throw new Error(`未脚本化的报告类型：${input.reportType}`);
      }
      calls.get(scripted.reportType)!.request += 1;
      return { jobId: scripted.jobId, raw: { requested: true } };
    },
    async getReportStatus(input) {
      const scripted = reportTypes.find(
        (entry) => entry.jobId === (input.jobId ?? input.reportId),
      );
      if (scripted === undefined) {
        throw new Error(`未脚本化的 Job：${input.jobId ?? input.reportId}`);
      }
      const counters = calls.get(scripted.reportType)!;
      counters.status += 1;
      if (counters.status === 1) {
        return { status: "waiting", raw: { state: "pending" } };
      }
      return {
        status: "ready",
        raw: { state: "ready" },
        dataAsOf: "2026-08-19T00:00:00.000Z",
      };
    },
    async downloadReport(input) {
      const scripted = reportTypes.find(
        (entry) => entry.jobId === (input.jobId ?? input.reportId),
      );
      if (scripted === undefined) {
        throw new Error(`未脚本化的 Job：${input.jobId ?? input.reportId}`);
      }
      calls.get(scripted.reportType)!.download += 1;
      return {
        rows: scripted.rows,
        raw: { csv: "scripted" },
        dataAsOf: "2026-08-19T00:00:00.000Z",
      };
    },
  };
  return { provider, calls };
}

async function fixture(
  run: (input: {
    root: string;
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
    await run({ root, configPath, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface LegacySlotInput {
  reportType: string;
  jobId: string;
  rows: ReportingRow[];
  /** 旧槽位的同步任务状态；缺省为已导入的完整槽位。 */
  status?: "imported" | "waiting";
}

/**
 * 按旧的单槽位布局（reporting/<频道>/latest-*）手工落盘既有数据，
 * 作为迁移等价性断言的独立事实来源。
 */
async function writeLegacySlot(
  root: string,
  input: LegacySlotInput,
): Promise<{ legacyState: object; legacyData: object }> {
  const imported = (input.status ?? "imported") === "imported";
  const channelRoot = join(root, ".ytops-data", "reporting", channelId);
  const legacyEvidenceDirectory = join(channelRoot, "evidence");
  const evidenceFileName = "2026-08-19T010000-000000Z-import.json";
  const legacyEvidenceFile = resolve(legacyEvidenceDirectory, evidenceFileName);
  const legacyState = {
    version: 1,
    channelId,
    jobId: input.jobId,
    reportId: input.jobId,
    reportType: input.reportType,
    status: input.status ?? "imported",
    coverage: imported ? "complete" : "async-processing",
    requestedAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-19T01:00:00.000Z",
    ...(imported ? { importedAt: "2026-08-19T01:00:00.000Z" } : {}),
    ...(imported ? { dataAsOf: "2026-08-19T00:00:00.000Z" } : {}),
    rowCount: imported ? input.rows.length : 0,
  };
  const legacyData = {
    version: 1,
    channelId,
    source: "youtube-reporting-api",
    jobId: input.jobId,
    reportId: input.jobId,
    reportType: input.reportType,
    rows: imported ? input.rows : [],
    evidence: [
      {
        path: legacyEvidenceFile,
        fetchedAt: "2026-08-19T01:00:00.000Z",
        phase: imported ? "import" : "request",
      },
    ],
    ...(imported ? { dataAsOf: "2026-08-19T00:00:00.000Z" } : {}),
  };
  await mkdir(legacyEvidenceDirectory, { recursive: true });
  await writeFile(
    join(channelRoot, "latest-state.json"),
    `${JSON.stringify(legacyState, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(channelRoot, "latest-data.json"),
    `${JSON.stringify(legacyData, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    legacyEvidenceFile,
    `${JSON.stringify(
      {
        source: "youtube-reporting-api",
        phase: "import",
        jobId: input.jobId,
        fetchedAt: "2026-08-19T01:00:00.000Z",
        response: { csv: "date,views" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { legacyState, legacyData };
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

  it("先后同步两种报表类型后，两种报表类型的状态与数据分别保存且互不覆盖", async () => {
    await fixture(async ({ configPath, store }) => {
      const basicRows: ReportingRow[] = [{ date: "2026-08-19", views: 5 }];
      const reachRows: ReportingRow[] = [
        { date: "2026-08-19", video: "v1", impressions: 100 },
      ];
      const { provider, calls } = createScriptedReportingProvider([
        { reportType: "channel-basic", jobId: "job-basic-1", rows: basicRows },
        {
          reportType: "channel-reach-basic",
          jobId: "job-reach-1",
          rows: reachRows,
        },
      ]);
      const dependencies: ReportingDependencies = {
        provider,
        credentialStore: store,
      };

      const basicWaiting = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(basicWaiting.state.status).toBe("waiting");
      const basicImported = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(basicImported.state.status).toBe("imported");
      expect(basicImported.state.jobId).toBe("job-basic-1");
      expect(basicImported.data.rows).toEqual(basicRows);

      const reachWaiting = await syncReporting(
        configPath,
        { channelId, reportType: "channel-reach-basic" },
        dependencies,
      );
      expect(reachWaiting.state.status).toBe("waiting");
      const reachImported = await syncReporting(
        configPath,
        { channelId, reportType: "channel-reach-basic" },
        dependencies,
      );
      expect(reachImported.state.status).toBe("imported");
      expect(reachImported.state.jobId).toBe("job-reach-1");
      expect(reachImported.data.rows).toEqual(reachRows);

      const rereadBasic = await getReportingStatus(configPath, channelId, {
        reportType: "channel-basic",
      });
      expect(rereadBasic.state.status).toBe("imported");
      expect(rereadBasic.state.jobId).toBe("job-basic-1");
      expect(rereadBasic.state.reportType).toBe("channel-basic");
      expect(rereadBasic.data.rows).toEqual(basicRows);

      const rereadReach = await getReportingStatus(configPath, channelId, {
        reportType: "channel-reach-basic",
      });
      expect(rereadReach.state.status).toBe("imported");
      expect(rereadReach.state.jobId).toBe("job-reach-1");
      expect(rereadReach.state.reportType).toBe("channel-reach-basic");
      expect(rereadReach.data.rows).toEqual(reachRows);

      expect(calls.get("channel-basic")).toEqual({
        request: 1,
        status: 2,
        download: 1,
      });
      expect(calls.get("channel-reach-basic")).toEqual({
        request: 1,
        status: 2,
        download: 1,
      });
    });
  });

  it("拒绝包含路径分隔符或相对段的报告类型，避免越出报告类型目录", async () => {
    await fixture(async ({ configPath, store }) => {
      const dependencies: ReportingDependencies = {
        provider: createScriptedReportingProvider([]).provider,
        credentialStore: store,
      };
      for (const reportType of ["../escape", "a/b", "..", "."]) {
        await expect(
          syncReporting(configPath, { channelId, reportType }, dependencies),
        ).rejects.toThrow("报告类型只能包含字母、数字、下划线和连字符");
        await expect(
          getReportingStatus(configPath, channelId, { reportType }),
        ).rejects.toThrow("报告类型只能包含字母、数字、下划线和连字符");
      }
    });
  });

  it("读取旧布局时一次性迁入对应报告类型目录，迁移前后可读数据等价", async () => {
    await fixture(async ({ root, configPath }) => {
      const basicRows: ReportingRow[] = [{ date: "2026-08-19", views: 5 }];
      const { legacyState, legacyData } = await writeLegacySlot(root, {
        reportType: "channel-basic",
        jobId: "job-legacy-1",
        rows: basicRows,
      });
      const channelRoot = resolve(root, ".ytops-data", "reporting", channelId);
      const migratedEvidencePath = resolve(
        channelRoot,
        "channel-basic",
        "evidence",
        "2026-08-19T010000-000000Z-import.json",
      );

      const migrated = await getReportingStatus(configPath, channelId, {
        reportType: "channel-basic",
      });

      expect(migrated.state).toEqual(legacyState);
      expect(migrated.data).toEqual({
        ...legacyData,
        evidence: [
          {
            path: migratedEvidencePath,
            fetchedAt: "2026-08-19T01:00:00.000Z",
            phase: "import",
          },
        ],
      });
      expect(await pathExists(migratedEvidencePath)).toBe(true);
      expect(await pathExists(resolve(channelRoot, "latest-state.json"))).toBe(
        false,
      );
      expect(await pathExists(resolve(channelRoot, "latest-data.json"))).toBe(
        false,
      );
    });
  });

  it("旧槽位属于其他报告类型时迁入其自身目录，不影响新报告类型", async () => {
    await fixture(async ({ root, configPath }) => {
      const legacyRows: ReportingRow[] = [
        { date: "2026-08-19", video: "v9", impressions: 7 },
      ];
      await writeLegacySlot(root, {
        reportType: "channel-basic-archive",
        jobId: "job-legacy-2",
        rows: legacyRows,
      });

      const fresh = await getReportingStatus(configPath, channelId, {
        reportType: "channel-basic",
      });
      expect(fresh.state.status).toBe("waiting");
      expect(fresh.state.rowCount).toBe(0);

      const migrated = await getReportingStatus(configPath, channelId, {
        reportType: "channel-basic-archive",
      });
      expect(migrated.state.jobId).toBe("job-legacy-2");
      expect(migrated.data.rows).toEqual(legacyRows);
    });
  });

  it("迁移后同步只写入新布局，旧路径不再写入", async () => {
    await fixture(async ({ root, configPath, store }) => {
      const { provider, calls } = createScriptedReportingProvider([
        {
          reportType: "channel-basic",
          jobId: "job-legacy-1",
          rows: [{ date: "2026-08-19", views: 5 }],
        },
      ]);
      await writeLegacySlot(root, {
        reportType: "channel-basic",
        jobId: "job-legacy-1",
        rows: [{ date: "2026-08-19", views: 5 }],
        status: "waiting",
      });
      const channelRoot = resolve(root, ".ytops-data", "reporting", channelId);
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
      expect(await pathExists(resolve(channelRoot, "latest-state.json"))).toBe(
        false,
      );

      const imported = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      expect(imported.state.status).toBe("imported");

      expect(await pathExists(resolve(channelRoot, "latest-state.json"))).toBe(
        false,
      );
      expect(await pathExists(resolve(channelRoot, "latest-data.json"))).toBe(
        false,
      );
      expect(
        await pathExists(
          resolve(channelRoot, "channel-basic", "latest-state.json"),
        ),
      ).toBe(true);
      expect(
        await pathExists(
          resolve(channelRoot, "channel-basic", "latest-data.json"),
        ),
      ).toBe(true);
      expect(calls.get("channel-basic")).toEqual({
        request: 0,
        status: 2,
        download: 1,
      });
    });
  });

  it("重复同步已导入的报表类型时短路返回，不重复导入也不影响其他报表类型", async () => {
    await fixture(async ({ configPath, store }) => {
      const basicRows: ReportingRow[] = [{ date: "2026-08-19", views: 5 }];
      const reachRows: ReportingRow[] = [
        { date: "2026-08-19", video: "v1", impressions: 100 },
      ];
      const { provider, calls } = createScriptedReportingProvider([
        { reportType: "channel-basic", jobId: "job-basic-1", rows: basicRows },
        {
          reportType: "channel-reach-basic",
          jobId: "job-reach-1",
          rows: reachRows,
        },
      ]);
      const dependencies: ReportingDependencies = {
        provider,
        credentialStore: store,
      };
      for (const scripted of [
        { reportType: "channel-basic", jobId: "job-basic-1" },
        { reportType: "channel-reach-basic", jobId: "job-reach-1" },
      ]) {
        await syncReporting(
          configPath,
          { channelId, reportType: scripted.reportType },
          dependencies,
        );
        await syncReporting(
          configPath,
          { channelId, reportType: scripted.reportType },
          dependencies,
        );
      }
      const callsAfterImport = JSON.stringify(calls);

      const resyncedBasic = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );
      const resyncedReach = await syncReporting(
        configPath,
        { channelId, reportType: "channel-reach-basic" },
        dependencies,
      );

      expect(JSON.stringify(calls)).toBe(callsAfterImport);
      expect(resyncedBasic.state.status).toBe("imported");
      expect(resyncedBasic.data.rows).toEqual(basicRows);
      expect(resyncedReach.state.status).toBe("imported");
      expect(resyncedReach.data.rows).toEqual(reachRows);
    });
  });

  it("迁移后的已导入槽位在重复同步时短路返回，数据保持等价", async () => {
    await fixture(async ({ root, configPath, store }) => {
      const legacyRows: ReportingRow[] = [{ date: "2026-08-19", views: 5 }];
      await writeLegacySlot(root, {
        reportType: "channel-basic",
        jobId: "job-legacy-1",
        rows: legacyRows,
      });
      const { provider, calls } = createScriptedReportingProvider([
        {
          reportType: "channel-basic",
          jobId: "job-legacy-1",
          rows: legacyRows,
        },
      ]);
      const dependencies: ReportingDependencies = {
        provider,
        credentialStore: store,
      };

      const resynced = await syncReporting(
        configPath,
        { channelId, reportType: "channel-basic" },
        dependencies,
      );

      expect(resynced.state.status).toBe("imported");
      expect(resynced.state.jobId).toBe("job-legacy-1");
      expect(resynced.data.rows).toEqual(legacyRows);
      expect(calls.get("channel-basic")).toEqual({
        request: 0,
        status: 0,
        download: 0,
      });
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
