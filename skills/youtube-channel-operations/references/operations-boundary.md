# Channel Operations Boundary

Run `npm run build` separately before the current readiness check from `D:\DEV\3_Projects\LP\MCP`. Call the built CLI directly so stdout contains only the JSON payload:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops doctor"
```

Current output reports only local tool availability and whether `YTOPS_GOOGLE_CLIENT_ID` and `YTOPS_GOOGLE_CLIENT_SECRET` are configured. It does not authenticate, save credentials, or call YouTube APIs.

Use official user OAuth for private data and channel writes. Do not use a service account for an individual YouTube channel. Before a future write operation, show the channel, target resource, requested change, privacy state, and verification plan, then obtain explicit confirmation.
