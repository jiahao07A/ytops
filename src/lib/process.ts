import { execa } from "execa";
import { ExternalCommandError } from "./errors.js";

export type CommandLaunchFailureKind =
  "missing" | "permission-denied" | "unlaunchable";

export type ExternalToolFailureKind =
  | CommandLaunchFailureKind
  | "non-zero-exit"
  | "malformed-output"
  | "invalid-output";

export interface ExternalToolFailure {
  kind: ExternalToolFailureKind;
  exitCode: number | null;
  detail: string;
}

export class ExternalToolError extends ExternalCommandError {
  constructor(
    command: string,
    args: string[],
    readonly kind: ExternalToolFailureKind,
    exitCode: number | undefined,
    detail: string,
  ) {
    super(command, args, exitCode, detail);
    this.name = "ExternalToolError";
  }
}

export function classifyCommandLaunchFailure(
  error: unknown,
): CommandLaunchFailureKind {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unlaunchable";
  }

  if (error.code === "ENOENT") {
    return "missing";
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return "permission-denied";
  }

  return "unlaunchable";
}

export function createCommandLaunchFailure(
  error: unknown,
): ExternalToolFailure {
  const kind = classifyCommandLaunchFailure(error);
  const detail =
    kind === "missing"
      ? "未在 PATH 中找到命令。"
      : kind === "permission-denied"
        ? "没有执行该命令的权限。"
        : "命令存在，但无法启动或不是有效的可执行文件。";
  return { kind, exitCode: null, detail };
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  launchFailure?: ExternalToolFailure;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const result = await execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    reject: false,
    shell: false,
    stdin: "ignore",
  });
  const launchFailure =
    result.exitCode === undefined && result.failed
      ? createCommandLaunchFailure(result)
      : undefined;

  return {
    command,
    args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    launchFailure,
  };
}
