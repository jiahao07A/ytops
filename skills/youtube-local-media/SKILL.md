---
name: youtube-local-media
description: 使用仓库内 ytops CLI 和 FFmpeg 配方检查、提取音频或裁剪本地视频和音频。用户需要可复现的媒体探测、音频衍生或不修改源文件的裁剪时使用。不要用于 YouTube 下载、浏览器凭据、字幕获取、OAuth 或频道写入。
---

# YouTube Local Media Processing

Use named `ytops process` recipes only. Preserve the source file and write every derivative to an explicit output path.

## Command Contract

Work from `D:\DEV\3_Projects\LP\MCP`. Read [references/local-media-contract.md](references/local-media-contract.md) before execution.

## Workflow

1. Confirm the input media path, requested outcome, output path, and whether an existing output may be overwritten.
2. Run `rtk node .\dist\cli.js --json process probe <input>` before a conversion or clip unless current media characteristics are already verified.
3. Use `process audio` for `mp3`, `m4a`, or `wav` derivatives. Use `process clip` only when the user accepts stream-copy behavior and its keyframe-boundary limitation.
4. Verify the emitted JSON success result. Probe the generated artifact when duration, codec, or stream structure affects the requested outcome.
5. Report the source path, output path, transformation recipe, and any limitations.

## Boundaries

- Do not mutate or delete the source file.
- Do not pass arbitrary FFmpeg flags or shell fragments.
- Do not use `--overwrite` unless the user explicitly approves replacing that exact output path.
- For frame-accurate edits, filters, subtitle burn-in, loudness normalization, transcription, or rough cuts, state that the current CLI recipe does not yet support the action rather than improvising a command.
