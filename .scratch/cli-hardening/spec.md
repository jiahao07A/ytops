# JSON 与 URL 安全加固

Status: resolved

## Problem Statement

CLI 的机器可解析 JSON、远程 URL 和凭据文件边界需要统一，避免 npm 输出、未知主机、命令行错误或常见秘密文件破坏自动化和安全合同。

## Delivered Scope

- 构建后的 CLI 作为 skills 的直接 JSON 入口，不使用会污染 stdout 的 npm 包装命令。
- Commander 参数错误保持单一 JSON 错误合同。
- 远程媒体 URL 限制为 HTTPS 的受支持 YouTube 单视频形态。
- `.gitignore` 覆盖常见 OAuth、token 和 cookies 文件名。

## Verification

历史审查中有一次外部审查服务返回 HTTP 503，未产生独立代码结论；该事件只作为历史记录保留，不代表当前实现未验证。当前验证入口为 `npm run verify`、构建后的 JSON CLI 调用、skills 合同测试和 `git diff --check`。
