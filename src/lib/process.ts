import { execa } from "execa";

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

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

  return {
    command,
    args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
