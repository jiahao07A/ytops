export const SYNC_TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "retrying",
  "partial",
  "failed",
  "completed",
] as const;

export type SyncTaskStatus = (typeof SYNC_TASK_STATUSES)[number];

export interface SyncTaskIdentity {
  id: string;
  channelConnectionId: string;
  source: string;
  scope: string[];
}

export interface SyncTaskError {
  kind: string;
  message: string;
  retryable: boolean;
}

export interface SyncTaskProjection {
  id: string;
  identity: SyncTaskIdentity;
  status: SyncTaskStatus;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastSuccessAt?: string;
  dataAsOf?: string;
  retryable: boolean;
  nextRetryAt?: string;
  error?: SyncTaskError;
}

export function createSyncTaskIdentity(input: {
  channelConnectionId: string;
  source: string;
  scope: readonly string[];
}): SyncTaskIdentity {
  const scope = [...new Set(input.scope)].sort();
  const id = `${input.source}:${input.channelConnectionId}:${scope.join("+")}`;
  return {
    id,
    channelConnectionId: input.channelConnectionId,
    source: input.source,
    scope,
  };
}

export function isTerminalSyncTaskFailure(
  task: Pick<SyncTaskProjection, "status">,
): boolean {
  return task.status === "failed";
}
