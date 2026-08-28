import {
  validateChannelOperationsConfig,
  type ChannelOperationsConfig,
} from "./config.js";
import {
  DEFAULT_INVENTORY_SCOPE,
  getInventoryStatus,
  syncInventory,
  type InventorySyncDependencies,
  type InventorySyncResult,
} from "./inventory.js";
import type { SyncTaskStatus } from "./sync-task.js";

export interface SchedulerTaskResult {
  channelId: string;
  status: "skipped" | SyncTaskStatus;
  due: boolean;
  result?: InventorySyncResult;
  error?: { message: string; kind: string };
}
export interface SchedulerRunResult {
  configPath: string;
  ranAt: string;
  tasks: SchedulerTaskResult[];
  summary: {
    total: number;
    due: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}
export interface SchedulerDependencies {
  now?: () => Date;
  validateConfig?: typeof validateChannelOperationsConfig;
  getStatus?: typeof getInventoryStatus;
  syncInventory?: typeof syncInventory;
  inventory?: Omit<InventorySyncDependencies, "now">;
}

function isDue(
  task: {
    status?: string;
    lastSuccessAt?: string;
    nextRetryAt?: string;
    retryable?: boolean;
  },
  now: Date,
  frequencyHours: number,
): boolean {
  if (task.nextRetryAt) return Date.parse(task.nextRetryAt) <= now.getTime();
  if (
    !task.lastSuccessAt ||
    task.status === "queued" ||
    task.status === "running"
  )
    return true;
  if (task.status === "failed" && task.retryable === false) return false;
  const last = Date.parse(task.lastSuccessAt);
  return Number.isNaN(last) || last + frequencyHours * 3600000 <= now.getTime();
}

export async function runDueInventoryTasks(
  configPath: string,
  deps: SchedulerDependencies = {},
): Promise<SchedulerRunResult> {
  const now = deps.now ?? (() => new Date());
  const validate = deps.validateConfig ?? validateChannelOperationsConfig;
  const getStatus = deps.getStatus ?? getInventoryStatus;
  const run = deps.syncInventory ?? syncInventory;
  const validated = await validate(configPath);
  const config = validated.config as ChannelOperationsConfig;
  const enabled = config.channels.filter(
    (channel) => channel.enabled !== false,
  );
  const tasks: SchedulerTaskResult[] = [];
  const due: Array<{
    channelId: string;
    frequencyHours: number;
    quotaBudget: number;
  }> = [];
  for (const channel of enabled) {
    try {
      const status = await getStatus(configPath, channel.channelId, {
        scope: DEFAULT_INVENTORY_SCOPE,
      });
      const settings = { ...config.global.sync, ...channel.sync };
      if (isDue(status.task, now(), settings.frequencyHours))
        due.push({
          channelId: channel.channelId,
          frequencyHours: settings.frequencyHours,
          quotaBudget: settings.quotaBudget,
        });
      else
        tasks.push({
          channelId: channel.channelId,
          status: "skipped",
          due: false,
        });
    } catch (error) {
      tasks.push({
        channelId: channel.channelId,
        status: "failed",
        due: false,
        error: {
          kind: "status",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  const limit = Math.max(1, config.global.sync.maxConcurrency);
  let cursor = 0;
  const worker = async () => {
    while (cursor < due.length) {
      const item = due[cursor++];
      try {
        const result = await run(
          configPath,
          {
            channelId: item.channelId,
            scope: DEFAULT_INVENTORY_SCOPE,
            maxWorkUnits: item.quotaBudget,
          },
          { ...(deps.inventory ?? {}), now } as never,
        );
        const status = result.task.status;
        tasks.push({
          channelId: item.channelId,
          status,
          due: true,
          result,
        });
      } catch (error) {
        tasks.push({
          channelId: item.channelId,
          status: "failed",
          due: true,
          error: {
            kind: "sync",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, due.length) }, () => worker()),
  );
  const order = new Map(
    enabled.map((channel, index) => [channel.channelId, index]),
  );
  tasks.sort(
    (left, right) =>
      (order.get(left.channelId) ?? 0) - (order.get(right.channelId) ?? 0),
  );
  return {
    configPath: validated.configPath,
    ranAt: now().toISOString(),
    tasks,
    summary: {
      total: enabled.length,
      due: due.length,
      succeeded: tasks.filter((t) => t.due && t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      skipped: tasks.filter((t) => t.status === "skipped").length,
    },
  };
}

export const runInventoryScheduler = runDueInventoryTasks;
