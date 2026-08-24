# 04 — 默认 365 天、最大 3650 天核心 Analytics 事实查询

Type: task

What to build: 让频道运营者请求默认 365 天、最大 3650 天的频道和视频级表现、互动数据回填，并通过 CLI/JSON 查询可复查的事实与实际覆盖范围。

Blocked by: 03 — 可恢复的基础数据仓库同步.

Status: resolved

- [x] 首次 Analytics 同步会按可恢复范围请求默认最近 365 天、最大 3650 天的核心频道和视频级表现、互动数据；受 OAuth 权限、频道资格、指标和官方可用窗口限制时，返回实际覆盖范围及部分覆盖、不可用或权限不足状态。
- [x] 用户可查询已同步的事实数据，并在每个结果中看到来源、数据截至时间和覆盖状态。
- [x] 不可用、权限不足或缺失的数据不会被转换为零值；CLI/JSON 返回可区分的状态和原因。
- [x] 自动测试能在无真实账号和无网络的条件下验证回填范围与 JSON 合同。

## Answer

- 新增 `src/lib/analytics.ts`，通过窄 `AnalyticsProvider` 适配官方 `reports.query`，保存频道/视频事实、分页检查点、覆盖状态和证据。
- 新增 `analytics-sync/status/query`；`auth-start --analytics` 可申请 `yt-analytics.readonly`，缺少权限时明确返回 permission 状态。
- 验证：Analytics 离线伪 API、365/3650 天边界、分页恢复、空值保留和 CLI JSON 测试通过。
