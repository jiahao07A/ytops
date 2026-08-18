# YouTube Studio 运营数据路线图

## Objective

定义本机 YouTube Studio 运营数据仓库的目标能力、依赖关系和当前交付状态。此路线图描述规划，不代表当前 CLI 已实现 OAuth、官方 API 请求、同步或频道写入。

## Frontier

01 已解决；02 和 10 已解除依赖，可作为后续实现入口。其余任务须按下表依赖推进。

## Active Tickets

| Ticket                                                                                   | Status   | Depends on |
| ---------------------------------------------------------------------------------------- | -------- | ---------- |
| [01 安全配置与配置合同](./issues/01-safe-configuration-contract.md)                      | resolved | None       |
| [02 OAuth 授权与显式频道接入](./issues/02-oauth-channel-connection.md)                   | open     | 01         |
| [03 可恢复的基础数据仓库同步](./issues/03-resumable-inventory-sync.md)                   | open     | 02         |
| [04 核心 Analytics 事实查询](./issues/04-core-analytics-backfill.md)                     | open     | 03         |
| [05 刷新、过期回退与配额状态](./issues/05-freshness-quota-resilience.md)                 | open     | 04         |
| [06 高维 Analytics 配置档案与按需查询](./issues/06-configurable-analytics-breakdowns.md) | open     | 05         |
| [07 异步 Reporting 数据源](./issues/07-asynchronous-reporting-source.md)                 | open     | 05         |
| [08 评论与可读取扩展数据源](./issues/08-comments-and-readable-extensions.md)             | open     | 05         |
| [09 覆盖矩阵与证据审计](./issues/09-coverage-matrix-and-evidence-audit.md)               | open     | 06, 07, 08 |
| [10 频道运营配置辅助 skill](./issues/10-channel-operations-config-skill.md)              | open     | 01         |

## Decisions

- “首次回填窗口”默认最近 365 天，最大可配置 3650 天；实际覆盖范围仍受 OAuth、频道资格、指标可用窗口和官方延迟限制。
- README 只描述当前已交付能力；本目录的规格、map 和 issues 维护规划状态，避免两处各自维护路线图。
- 令牌、客户端秘密和浏览器 Cookie 不进入配置、日志、JSON 或 Git；频道写入不在本路线图首期范围内。

## Current Implementation Boundary

当前 CLI 已交付媒体发现、字幕、授权媒体、本地媒体处理、配置管理和 `ops doctor` 就绪检查。OAuth 授权、频道数据仓库、同步、Analytics 查询、Reporting、评论同步和 MCP 适配层仍未实现。
