# YouTube 运营数据工具生产可用性路线图

## Objective

把现有离线可测试的公开内容检索和 YouTube Studio 只读数据能力补全为真实可用、可持续同步且数据可核验的本机运营数据工具。

## Frontier

01、02、04 已并行认领。新的 agent 前沿将在这些票据完成后按阻塞关系开放；真实环境票据 14-18 只有在其阻塞项完成并取得相应本机权限或测试频道授权后才能推进。

## Tickets

| Ticket                                                                                  | Labels          | Status  | Blocked by             |
| --------------------------------------------------------------------------------------- | --------------- | ------- | ---------------------- |
| [01 公开检索与外部工具诊断合同](./issues/01-public-search-diagnostics.md)               | -               | claimed | None                   |
| [02 OAuth 持久续期生命周期](./issues/02-oauth-token-refresh.md)                         | -               | claimed | None                   |
| [03 最小授权与货币数据权限](./issues/03-least-privilege-scopes.md)                      | ready-for-agent | open    | 02                     |
| [04 以 Inventory 贯通统一同步任务合同](./issues/04-inventory-task-contract.md)          | -               | claimed | None                   |
| [05 运行所有到期 Inventory 任务](./issues/05-due-inventory-scheduler.md)                | ready-for-agent | open    | 02, 04                 |
| [06 跨进程互斥与有界并发](./issues/06-cross-process-concurrency.md)                     | ready-for-agent | open    | 05                     |
| [07 显式管理 Windows 定期任务](./issues/07-windows-task-scheduler.md)                   | ready-for-agent | open    | 06                     |
| [08 核心 Analytics 可信同步](./issues/08-core-analytics-trustworthy-sync.md)            | ready-for-agent | open    | 06                     |
| [09 高维 Analytics 档案可信同步](./issues/09-analytics-breakdown-sync.md)               | ready-for-agent | open    | 03, 08                 |
| [10 Reporting 官方任务与报告发现生命周期](./issues/10-reporting-lifecycle.md)           | ready-for-agent | open    | 06                     |
| [11 Reporting CSV 与持续日报导入](./issues/11-reporting-csv-daily-import.md)            | ready-for-agent | open    | 10                     |
| [12 评论线程、回复与部分覆盖](./issues/12-comments-replies-coverage.md)                 | ready-for-agent | open    | 06                     |
| [13 事实查询、覆盖矩阵与证据生命周期](./issues/13-facts-coverage-evidence-lifecycle.md) | ready-for-agent | open    | 08, 09, 11, 12         |
| [14 真实公开内容检索验收](./issues/14-live-yt-dlp-acceptance.md)                        | ready-for-human | open    | 01                     |
| [15 真实 OAuth、DPAPI 与官方 API 冒烟验收](./issues/15-live-oauth-api-smoke.md)         | ready-for-human | open    | 03, 04, 08, 09, 10, 12 |
| [16 真实持续同步与系统调度验收](./issues/16-live-continuous-sync-acceptance.md)         | ready-for-human | open    | 07, 13, 15             |
| [17 真实 Reporting 等待状态验收](./issues/17-live-reporting-waiting.md)                 | ready-for-human | open    | 07, 10, 15             |
| [18 真实 Reporting 恢复与导入验收](./issues/18-live-reporting-import.md)                | ready-for-human | open    | 11, 13, 17             |

## Decisions

- 01-13 是可由 agent 认领的实现与自动验收票据；14-18 涉及本机外部工具、OAuth 凭据、测试频道或长时间官方报告生成，因此是人工验收票据。
- 自动化测试的最高接缝是构建后的 CLI JSON 合同；Google/YouTube provider 只保留必要的窄合同测试。
- Inventory 是统一同步任务状态和一次性到期调度的首个 tracer，后续数据源在各自票据中接入相同合同。
- Reporting 的真实等待和真实导入分成两张票，避免官方报告生成时间占用一个实现上下文。
- 频道写入、Studio 网页镜像、MCP、前端、直播和内置 AI 结论仍不在本路线图范围内。
