export class UserInputError extends Error {
  readonly code = "USER_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export class ExternalCommandError extends Error {
  readonly code = "EXTERNAL_COMMAND";

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(
      `${command} failed${exitCode === undefined ? "" : ` with exit code ${exitCode}`}.`,
    );
    this.name = "ExternalCommandError";
  }
}
