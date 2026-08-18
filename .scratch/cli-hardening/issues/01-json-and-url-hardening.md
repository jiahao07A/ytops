# JSON 与 URL 安全加固

Type: task
Blocked by: None — can start immediately.
Status: resolved
Source: 2026-08-17 未提交变更代码审查

## 范围

- 让 `--json` 在 Commander 参数校验错误时仍输出单一 JSON 错误对象。
- 让 skills 直接调用构建后的 CLI，避免 npm 横幅污染 JSON。
- 将远程 URL 限制为 HTTPS 的 YouTube 控制域名。
- 忽略常见 OAuth 与 cookies 凭据文件名。

## Review History

### Round 1: 原始未提交变更

- [P1] skill 示例通过 `npm run start -- --json` 调用 CLI，npm 横幅会破坏机器可解析 JSON。
- [P2] Commander 的缺少参数、未知选项等错误绕过了 JSON 错误协议。
- [P2] URL 校验只限制协议，仍允许 localhost、内网及任意第三方主机。
- [P2] `.gitignore` 未覆盖常见 OAuth 客户端密钥和 cookies 文件。

### Round 2: 独立复审

- [P1] 仅检查域名会接受 YouTube 的跳转端点，可能将请求导向 localhost、内网或第三方；需限制为已知单视频 URL 形态。
- [P2] `README.md` 的 JSON 示例仍使用 `npm run start`，会污染 stdout。
- [P2] `.gitignore` 未忽略 `cookie.txt`、连字符/下划线形式的 OAuth token 文件。

以上三项已修复并完成回归验证。

### Round 3: 独立复审

- [P2] 四个 `SKILL.md` 正文仍使用未安装的全局 `ytops --json` 命令，和 references 中的仓库内直接入口不一致。
- [P3] 包描述、skill 触发描述和界面简述包含英文，不符合面向用户文本使用简体中文的项目约束。

上述问题已修复并完成回归验证。

### Round 4: 最终独立复审

- 已启动新的独立审查任务，但审查模型服务返回 HTTP 503，未产生代码结论。
- 该外部服务故障作为历史审查限制保留记录；本地构建、测试、skills 合同检查和命令级安全验证已完成，不代表当前仍存在未评估的代码缺陷。

## Verification Record

- 已运行类型检查、测试与构建。
- 已确认 JSON 参数错误可被 `JSON.parse` 解析且 stderr 为空。
- 已确认安全 URL 允许清单与凭据忽略规则生效。
- 独立审查服务的 503 结果已记录在 Round 4；本地验证结果见本文件 Comments。

## Comments

- 2026-08-17：用户要求修复全部已确认问题。
- 2026-08-17：已完成 `npm run check`、`npm test`（5 个测试文件、35 项）、四个 skill 校验与命令级安全验证；用户明确批准创建初始提交。
