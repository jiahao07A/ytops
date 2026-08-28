import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { UserInputError } from "./errors.js";
import { validateChannelOperationsConfig } from "./config.js";

export interface TaskSchedulerState {
  taskName: string;
  frequencyHours: number;
  workingDirectory: string;
  command: string;
  installedAt: string;
  enabled: boolean;
}

export type TaskSchedulerStateErrorKind =
  "invalid-state" | "permission-denied" | "read-failed" | "busy";

export class TaskSchedulerStateError extends Error {
  readonly code = "TASK_SCHEDULER_STATE";

  constructor(
    readonly kind: TaskSchedulerStateErrorKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "TaskSchedulerStateError";
  }
}

const taskName = "ytops-inventory-scheduler";

const taskSchedulerStateSchema = z
  .object({
    taskName: z.string().min(1),
    frequencyHours: z.number().int().min(1).max(168),
    workingDirectory: z.string().min(1),
    command: z.string().min(1),
    installedAt: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict() as z.ZodType<TaskSchedulerState>;

function statePath(configPath: string): string {
  return resolve(`${configPath}.scheduler.json`);
}

function ensureWindows(): void {
  if (process.platform !== "win32") {
    throw new UserInputError("Windows Task Scheduler 仅支持 Windows 环境。");
  }
}

function isFsCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function readState(
  configPath: string,
): Promise<TaskSchedulerState | undefined> {
  let text: string;
  try {
    text = await readFile(statePath(configPath), "utf8");
  } catch (error) {
    if (isFsCode(error, "ENOENT")) return undefined;
    if (isFsCode(error, "EACCES") || isFsCode(error, "EPERM")) {
      throw new TaskSchedulerStateError(
        "permission-denied",
        false,
        "无法读取本机调度状态文件：当前进程没有读取权限。",
      );
    }
    throw new TaskSchedulerStateError(
      "read-failed",
      true,
      "无法读取本机调度状态文件，请稍后重试。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskSchedulerStateError(
      "invalid-state",
      false,
      "本机调度状态文件格式无效，请移除后重新安装调度任务。",
    );
  }
  const validated = taskSchedulerStateSchema.safeParse(parsed);
  if (!validated.success) {
    throw new TaskSchedulerStateError(
      "invalid-state",
      false,
      "本机调度状态文件格式无效，请移除后重新安装调度任务。",
    );
  }
  return validated.data;
}

async function writeState(
  configPath: string,
  state: TaskSchedulerState,
): Promise<void> {
  const path = statePath(configPath);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isFsCode(error, "ENOENT")) throw error;
    });
  }
}

async function withStateLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = statePath(configPath);
  await mkdir(dirname(path), { recursive: true });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 100, minTimeout: 25, maxTimeout: 250 },
    });
  } catch (error) {
    if (isFsCode(error, "ELOCKED")) {
      throw new TaskSchedulerStateError(
        "busy",
        true,
        "本机调度状态正在被另一个进程更新，请稍后重试。",
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release?.();
  }
}

export async function getTaskSchedulerStatus(configPath: string) {
  ensureWindows();
  return withStateLock(configPath, async () => {
    const validated = await validateChannelOperationsConfig(configPath);
    const configuredFrequency = validated.config.global.sync.frequencyHours;
    const state = await readState(configPath);
    return {
      supported: true,
      installed: state?.enabled === true,
      taskName,
      configuredFrequencyHours: configuredFrequency,
      state,
      drift:
        state === undefined
          ? false
          : state.frequencyHours !== configuredFrequency,
    };
  });
}

export async function installTaskScheduler(
  configPath: string,
  confirm = false,
) {
  ensureWindows();
  return withStateLock(configPath, async () => {
    const validated = await validateChannelOperationsConfig(configPath);
    const frequencyHours = validated.config.global.sync.frequencyHours;
    const workingDirectory = dirname(resolve(configPath));
    const command = `ytops --json ops channel scheduler run --config "${resolve(configPath)}"`;
    const current = await readState(configPath);
    const preview = {
      supported: true,
      installed: current?.enabled === true,
      changed:
        current?.enabled !== true || current.frequencyHours !== frequencyHours,
      requiresConfirmation: true,
      taskName,
      frequencyHours,
      workingDirectory,
      command,
      impact: "将写入本机调度适配器状态；不会保存凭据。",
    };
    if (!confirm) return preview;
    if (
      current?.enabled === true &&
      current.frequencyHours === frequencyHours &&
      current.taskName === taskName &&
      current.workingDirectory === workingDirectory &&
      current.command === command
    ) {
      return {
        ...preview,
        installed: true,
        changed: false,
        requiresConfirmation: false,
        state: current,
      };
    }
    const next: TaskSchedulerState = {
      taskName,
      frequencyHours,
      workingDirectory,
      command,
      installedAt: new Date().toISOString(),
      enabled: true,
    };
    await writeState(configPath, next);
    return {
      ...preview,
      installed: true,
      changed: true,
      requiresConfirmation: false,
      state: next,
    };
  });
}

export async function disableTaskScheduler(
  configPath: string,
  confirm = false,
) {
  ensureWindows();
  return withStateLock(configPath, async () => {
    const current = await readState(configPath);
    const preview = {
      supported: true,
      installed: current?.enabled === true,
      changed: current?.enabled === true,
      requiresConfirmation: true,
      taskName,
      impact: "将停用本机调度适配器状态；不会删除运营数据。",
    };
    if (!confirm) return preview;
    if (current === undefined) {
      return {
        ...preview,
        installed: false,
        changed: false,
        requiresConfirmation: false,
      };
    }
    if (current.enabled === false) {
      return {
        ...preview,
        installed: false,
        changed: false,
        requiresConfirmation: false,
        state: current,
      };
    }
    const next = { ...current, enabled: false };
    await writeState(configPath, next);
    return {
      ...preview,
      installed: false,
      changed: true,
      requiresConfirmation: false,
      state: next,
    };
  });
}
