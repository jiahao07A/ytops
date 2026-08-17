# Local Media Contract

Run `npm run build` separately before executing commands from `D:\DEV\3_Projects\LP\MCP`. Call the built CLI directly so stdout contains only the JSON payload:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json process probe '<input-file>'"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json process audio '<input-file>' --output '<output-file>' --format m4a"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json process clip '<input-file>' --start 00:01:05 --end 00:01:25 --output '<output-file>'"
```

Add `--overwrite` only after the user approves replacing the exact output file. `process clip` uses FFmpeg stream copy and can start or end on a nearby keyframe.
