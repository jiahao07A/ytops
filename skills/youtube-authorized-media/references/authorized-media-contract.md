# Authorized Media Contract

Run `npm run build` separately before executing commands from `D:\DEV\3_Projects\LP\MCP`, then put `--json` before the subcommand. Call the built CLI directly so stdout contains only the JSON payload.

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json download video '<https-url>' --quality 1080p --output-dir '<directory>' --rights-confirmed"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json download audio '<https-url>' --output-dir '<directory>' --rights-confirmed"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json captions fetch '<https-url>' --language zh-Hant --output-dir '<directory>' --rights-confirmed"
```

The command returns a JSON object with `data.outputDirectory` and `data.files`. Treat missing or empty `files` as an incomplete intake and inspect the reported command error before proceeding.
