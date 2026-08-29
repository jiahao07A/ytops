---
name: youtube-authorized-media
description: 仅为用户明确拥有或获授权下载和处理的 YouTube 内容准备视频、音频或字幕文件。用户请求授权下载、授权字幕获取或可复现的本地媒体接入流程时使用。不要用于浏览、私有频道操作、未经用户提供的 Cookie 来源或未确认授权的第三方内容。
---

# YouTube Authorized Media

Use this skill only after the user explicitly confirms that they own the target content or have permission to download and process it. The CLI requires the same acknowledgement through `--rights-confirmed`; never add that flag based on assumption.

## Command Contract

Work from `D:\DEV\3_Projects\LP\MCP`. Read [references/authorized-media-contract.md](references/authorized-media-contract.md) before execution.

## Workflow

1. Obtain explicit confirmation of ownership or authorization. If it is absent or ambiguous, ask the user before any write action.
2. Confirm the exact URL, desired media type, resolution or audio format, and a dedicated output directory. Do not silently use the user's Downloads directory.
3. Run `rtk node .\dist\cli.js --json doctor` when the local environment is not already verified.
4. Use the relevant high-level command with `--rights-confirmed`.
5. Verify the CLI result reports `ok: true`, record the returned artifact paths, and run `$youtube-local-media` when local conversion or clipping is needed.

## Boundaries

- Do not pass OAuth refresh tokens or user-level `yt-dlp` configuration. Cookie opt-in (`--cookies <file>` / `--cookies-from-browser <spec>`) is allowed only when the user explicitly provides the source; prefer an exported Netscape cookie file or `firefox` on Windows (Chrome/Edge 127+ App-Bound Encryption). Never print, copy, commit, or retain cookie files outside the user-provided path.
- Do not add arbitrary `yt-dlp` flags, disable certificate validation, or invoke `@kevinwatt/yt-dlp-mcp` directly.
- Do not overwrite an existing output unless the user explicitly authorizes it and the downstream command exposes an overwrite flag.
- Stop and report extraction failures; do not evade platform controls or retry with credentials.
