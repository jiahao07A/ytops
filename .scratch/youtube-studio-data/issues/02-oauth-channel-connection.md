# 02 — OAuth 授权与显式频道接入

Type: task

What to build: 让频道运营者按照安全指引完成官方用户 OAuth 授权，明确选择一个可访问频道并建立可查看状态的频道接入。

Blocked by: 01 — 安全配置与配置合同.

Status: resolved

- [x] 用户能获得 Google Cloud、OAuth 同意屏幕、客户端环境配置和授权步骤的指引，且指引不要求回显秘密。
- [x] 授权后系统展示所有可访问频道，用户必须明确选择目标频道，不能默认选择第一个频道。
- [x] 每个频道接入独立保存其状态和安全凭据关联；CLI/JSON 可查询接入是否可用及不可用原因。
- [x] 令牌和客户端秘密只进入操作系统受保护凭据存储，不进入配置、日志或 JSON 输出。

## Answer

- 新增官方只读 OAuth 工作流：授权 URL、state 校验、授权码交换、频道分页发现和显式频道选择。
- 新增 Windows 用户级 DPAPI 凭据存储；OAuth 令牌和客户端秘密不进入配置、状态 JSON、日志或 Git。默认 `.ytops-data/` 已加入 `.gitignore`。
- 新增 `ops channel auth-start/auth-complete/list/status/select`，状态可区分未连接、待选择、已连接、凭据缺失、访问令牌过期和 OAuth API 验证失败。
- 状态文件使用严格 Zod schema 校验，拒绝未知字段或损坏状态；OAuth state 采用哈希、常量时间比较和十分钟有效期。
- 验证：`npm run verify`（Prettier、TypeScript、Vitest）；OAuth/DPAPI/CLI 定向测试覆盖伪 OAuth、分页、显式选择、秘密脱敏、过期/撤销/缺失凭据和状态篡改。
- 后续限制：频道写入仍不在本期范围；03-10 的只读数据获取链路已分别交付。真实账号人工 OAuth/API 验收未在本次离线测试中执行。

## Comments

- 2026-08-19：实现完成，按 `implement` 工作流完成定向测试、全量质量门禁和 Standards/Spec 复审；等待用户确认后提交 Git。
