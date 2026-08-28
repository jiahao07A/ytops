import type { ExternalToolFailureKind } from "./process.js";
import type { OAuthTokenRefreshError } from "./oauth.js";
import {
  isTerminalSyncTaskFailure,
  type SyncTaskProjection,
} from "./sync-task.js";
import type { SchedulerRunResult } from "./scheduler.js";

export interface CliFailure {
  code: string;
  message: string;
  details?: unknown;
  kind?: string;
  retryable?: boolean;
}

const EXTERNAL_TOOL_ERROR_CODES: Record<ExternalToolFailureKind, string> = {
  missing: "EXTERNAL_TOOL_NOT_FOUND",
  "permission-denied": "EXTERNAL_TOOL_PERMISSION_DENIED",
  unlaunchable: "EXTERNAL_TOOL_UNLAUNCHABLE",
  "non-zero-exit": "EXTERNAL_COMMAND_FAILED",
  "malformed-output": "EXTERNAL_RESPONSE_MALFORMED",
  "invalid-output": "EXTERNAL_RESPONSE_INVALID",
};

export function externalToolErrorCode(kind: ExternalToolFailureKind): string {
  return EXTERNAL_TOOL_ERROR_CODES[kind];
}

export function oauthRefreshFailure(error: OAuthTokenRefreshError): CliFailure {
  return {
    code: error.code,
    message: error.message,
    kind: error.kind,
    retryable: error.retryable,
  };
}

export function inventorySyncFailure(result: {
  task: SyncTaskProjection;
}): CliFailure | undefined {
  if (!isTerminalSyncTaskFailure(result.task)) {
    return undefined;
  }

  return {
    code: "INVENTORY_SYNC_FAILED",
    message: result.task.error?.message ?? "频道基础数据同步失败。",
    details: { task: result.task },
  };
}

export function schedulerRunFailure(
  result: SchedulerRunResult,
): CliFailure | undefined {
  if (result.summary.failed === 0) {
    return undefined;
  }

  return {
    code: "INVENTORY_SCHEDULER_FAILED",
    message: "一个或多个频道同步任务失败。",
    details: result,
  };
}
