# YouTube Studio 运营数据路线图

## Objective

定义本机 YouTube Studio 运营数据仓库的目标能力、依赖关系和当前交付状态。当前 CLI 已实现 01-10 的只读数据获取能力；频道写入和 MCP 适配层仍不在范围内。

## Frontier

01-10 均已解决；真实账号 OAuth/API 验收仍需单独执行，不改变离线实现的覆盖状态。

## Active Tickets

| Ticket                                                                                          | Status   | Depends on |
| ----------------------------------------------------------------------------------------------- | -------- | ---------- |
| [01 安全配置与配置合同](./issues/01-safe-configuration-contract.md)                             | resolved | None       |
| [02 OAuth 授权与显式频道接入](./issues/02-oauth-channel-connection.md)                          | resolved | 01         |
| [03 可恢复的基础数据仓库同步](./issues/03-resumable-inventory-sync.md#answer)                   | resolved | 02         |
| [04 核心 Analytics 事实查询](./issues/04-core-analytics-backfill.md#answer)                     | resolved | 03         |
| [05 刷新、过期回退与配额状态](./issues/05-freshness-quota-resilience.md#answer)                 | resolved | 04         |
| [06 高维 Analytics 配置档案与按需查询](./issues/06-configurable-analytics-breakdowns.md#answer) | resolved | 05         |
| [07 异步 Reporting 数据源](./issues/07-asynchronous-reporting-source.md#answer)                 | resolved | 05         |
| [08 评论与可读取扩展数据源](./issues/08-comments-and-readable-extensions.md#answer)             | resolved | 05         |
| [09 覆盖矩阵与证据审计](./issues/09-coverage-matrix-and-evidence-audit.md#answer)               | resolved | 06, 07, 08 |
| [10 频道运营配置辅助 skill](./issues/10-channel-operations-config-skill.md#answer)              | resolved | 01         |

## Decisions

- “首次回填窗口”默认最近 365 天，最大可配置 3650 天；实际覆盖范围仍受 OAuth、频道资格、指标可用窗口和官方延迟限制。
- README 只描述当前已交付能力；本目录的规格、map 和 issues 维护规划状态，避免两处各自维护路线图。
- 令牌、客户端秘密和浏览器 Cookie 不进入配置、日志、JSON 或 Git；频道写入不在本路线图首期范围内。
- 2026-08-19 已确认并行开发批次：批次 1 并行推进 02 OAuth 接入与 10 配置辅助 skill；随后依次推进 03 基础同步、04 核心 Analytics、05 新鲜度与配额韧性；05 完成后并行推进 06 高维 Analytics、07 Reporting、08 评论扩展；最后由主 agent 汇合 09 覆盖矩阵与证据审计。
- 共享状态合同和跨模块汇合由主 agent 维护；并行任务只消费已冻结的频道身份、同步状态、覆盖状态、错误分类和证据引用合同，避免修改同一共享边界。
- 01 的定向测试已通过，但全量双轴复审仍是质量闸门；只有复审发现配置合同问题时，才升级为 02 和 10 的阻塞项。
- 2026-08-19：02 已完成 OAuth 授权、频道分页发现、显式选择、DPAPI 凭据保护和可用性状态；验证见 [02 Answer](./issues/02-oauth-channel-connection.md#answer)。10 已完成配置辅助 skill 的意图路由、确认闸门和 OAuth 越权边界；验证见 [10 Answer](./issues/10-channel-operations-config-skill.md#answer)。
- 2026-08-19：03-05 已按关键路径完成基础同步、核心 Analytics 和新鲜度合同；验证见各票据 Answer。
- 2026-08-19：06-08 已完成高维 Analytics、异步 Reporting 和只读评论；09 汇合覆盖矩阵与证据审计，所有能力保持官方 API 资格和延迟限制的显式状态。

## Current Implementation Boundary

当前 CLI 已交付媒体发现、字幕、授权媒体、本地媒体处理、配置管理、`ops doctor`、只读 OAuth、可恢复元数据同步、核心/高维 Analytics、异步 Reporting、只读评论和覆盖矩阵。频道写入与 MCP 适配层仍未实现。
