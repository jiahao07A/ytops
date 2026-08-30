import { dirname, resolve } from "node:path";
import { getAnalyticsStatus } from "./analytics.js";
import { getCommentsStatus } from "./comments.js";
import {
  containsCredentialLikeText,
  validateChannelOperationsConfig,
} from "./config.js";
import { getInventoryStatus } from "./inventory.js";
import { getChannelConnectionStatus } from "./oauth.js";
import { getRetentionStatus } from "./retention.js";
import { getReportingStatus } from "./reporting.js";

export type CoverageMatrixStatus =
  | "supported"
  | "partial"
  | "qualification-limited"
  | "estimated"
  | "async-processing"
  | "unavailable";

export interface CoverageMatrixEntry {
  capability: string;
  source: string;
  status: CoverageMatrixStatus;
  scope: string;
  dataAsOf?: string;
  reportStatus?: string;
  reason?: string;
  evidencePaths: string[];
}

export interface CoverageMatrix {
  channelId: string;
  generatedAt: string;
  entries: CoverageMatrixEntry[];
}

function safeEvidencePaths(paths: string[]): string[] {
  return paths.filter((path) => !containsCredentialLikeText(path));
}

export async function getCoverageMatrix(
  configPath: string,
  channelId: string,
): Promise<CoverageMatrix> {
  const connectionStatus = await getChannelConnectionStatus(configPath);
  const inventoryConnections = connectionStatus.connections.filter(
    (connection) => connection.channelId === channelId,
  );
  const inventoryConnection =
    inventoryConnections.length === 1 ? inventoryConnections[0] : undefined;
  const [inventory, analytics, reporting, comments, retention] =
    await Promise.all([
      inventoryConnection === undefined
        ? Promise.resolve(undefined)
        : getInventoryStatus(configPath, channelId),
      getAnalyticsStatus(configPath, channelId),
      getReportingStatus(configPath, channelId),
      getCommentsStatus(configPath, channelId),
      getRetentionStatus(configPath, channelId),
    ]);
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  const inventoryEvidence =
    inventoryConnection === undefined
      ? []
      : [
          resolve(
            dataDirectory,
            "inventory",
            channelId,
            "connections",
            encodeURIComponent(inventoryConnection.connectionId),
            "tasks",
            "youtube-data-api",
            "channel+uploads+videos",
            "evidence",
          ),
        ];
  const inventoryUnavailableReason =
    inventoryConnections.length === 0
      ? "目标频道尚未建立唯一的频道接入。"
      : inventoryConnections.length > 1
        ? "目标频道存在多个频道接入，无法安全确定 Inventory 任务身份。"
        : undefined;

  const inventoryStatus: CoverageMatrixStatus =
    inventory === undefined
      ? "unavailable"
      : inventory.state.status === "completed"
        ? "supported"
        : inventory.state.status === "partial"
          ? "partial"
          : inventory.state.status === "failed"
            ? "unavailable"
            : "partial";
  const analyticsStatus: CoverageMatrixStatus =
    analytics.state.coverage === "permission-denied"
      ? "qualification-limited"
      : analytics.state.coverage === "complete" &&
          analytics.state.status === "completed"
        ? "supported"
        : analytics.state.status === "completed"
          ? "partial"
          : "unavailable";
  const audienceStatus: CoverageMatrixStatus =
    analytics.state.audienceCoverage === "permission-denied"
      ? "qualification-limited"
      : analytics.data.audienceRows === undefined ||
          analytics.state.audienceCoverage === undefined ||
          analytics.state.audienceCoverage === "unavailable"
        ? "unavailable"
        : analytics.state.status === "completed" &&
            analytics.state.audienceCoverage === "complete"
          ? "supported"
          : "partial";
  const reportingStatus: CoverageMatrixStatus =
    reporting.state.status === "imported"
      ? "supported"
      : reporting.state.status === "requested" ||
          reporting.state.status === "waiting" ||
          reporting.state.status === "ready"
        ? "async-processing"
        : reporting.state.status === "failed"
          ? "unavailable"
          : "unavailable";
  const commentsStatus: CoverageMatrixStatus =
    comments.state.coverage === "permission-denied"
      ? "qualification-limited"
      : comments.state.status === "completed" &&
          comments.state.coverage === "complete"
        ? "supported"
        : comments.state.status === "completed"
          ? "partial"
          : "unavailable";
  const retentionStatus: CoverageMatrixStatus =
    retention.state.coverage === "permission-denied"
      ? "qualification-limited"
      : retention.state.coverage === "complete" &&
          retention.state.status === "completed"
        ? "supported"
        : retention.state.status === "completed"
          ? "partial"
          : "unavailable";

  return {
    channelId,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        capability: "inventory.metadata",
        source: inventory?.data.source ?? "youtube-data-api",
        status: inventoryStatus,
        scope: "频道、上传播放列表和视频元数据",
        ...(inventory?.state.dataAsOf === undefined
          ? {}
          : { dataAsOf: inventory.state.dataAsOf }),
        ...(inventoryUnavailableReason !== undefined
          ? { reason: inventoryUnavailableReason }
          : inventory?.state.error === undefined
            ? {}
            : { reason: inventory.state.error.message }),
        evidencePaths: safeEvidencePaths(inventoryEvidence),
      },
      {
        capability: "analytics.core",
        source: analytics.data.source,
        status: analyticsStatus,
        scope: "频道和视频核心表现、互动指标",
        ...(analytics.data.dataAsOf === undefined
          ? {}
          : { dataAsOf: analytics.data.dataAsOf }),
        ...(analytics.state.error === undefined
          ? {}
          : { reason: analytics.state.error.message }),
        evidencePaths: safeEvidencePaths(
          analytics.data.evidence.map((evidence) => evidence.path),
        ),
      },
      {
        capability: "analytics.audience",
        source: analytics.data.source,
        status: audienceStatus,
        scope: "频道级观众画像:流量来源、国家、年龄与性别、订阅状态",
        ...(analytics.data.dataAsOf === undefined
          ? {}
          : { dataAsOf: analytics.data.dataAsOf }),
        ...(analytics.state.error === undefined
          ? {}
          : { reason: analytics.state.error.message }),
        evidencePaths: safeEvidencePaths(
          analytics.data.evidence
            .filter((evidence) => evidence.phase === "audience")
            .map((evidence) => evidence.path),
        ),
      },
      {
        capability: "analytics.breakdown",
        source: "youtube-analytics-api",
        status: "partial",
        scope: "按需高维查询；收入和受众字段受资格、估算和隐私阈值限制",
        reason: "高维查询不会预下载全部组合，结果必须以单次查询覆盖状态为准。",
        evidencePaths: [],
      },
      {
        capability: "reporting.async",
        source: reporting.data.source,
        status: reportingStatus,
        scope: `报告类型 ${reporting.state.reportType}`,
        reportStatus: reporting.state.status,
        ...(reporting.data.dataAsOf === undefined
          ? {}
          : { dataAsOf: reporting.data.dataAsOf }),
        ...(reporting.state.error === undefined
          ? {}
          : { reason: reporting.state.error.message }),
        evidencePaths: safeEvidencePaths(
          reporting.data.evidence.map((evidence) => evidence.path),
        ),
      },
      {
        capability: "comments.readonly",
        source: comments.data.source,
        status: commentsStatus,
        scope: "只读评论及可读取回复字段",
        ...(comments.data.dataAsOf === undefined
          ? {}
          : { dataAsOf: comments.data.dataAsOf }),
        ...(comments.state.error === undefined
          ? {}
          : { reason: comments.state.error.message }),
        evidencePaths: safeEvidencePaths(
          comments.data.evidence.map((evidence) => evidence.path),
        ),
      },
      {
        capability: "retention.curve",
        source: retention.data.source,
        status: retentionStatus,
        scope: "单个视频的全历史留存曲线（官方固定约 100 个进度比例点）",
        ...(retention.data.dataAsOf === undefined
          ? {}
          : { dataAsOf: retention.data.dataAsOf }),
        ...(retention.state.error === undefined
          ? {}
          : { reason: retention.state.error.message }),
        evidencePaths: safeEvidencePaths(
          retention.data.curves.map((curve) => curve.evidencePath),
        ),
      },
    ],
  };
}
