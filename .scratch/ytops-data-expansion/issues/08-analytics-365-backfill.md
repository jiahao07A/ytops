# 08: 365 天 Analytics 回填补完

Type: task
Status: open
Label: ready-for-agent
Blocked by: none

**What to build:** 当前运营数据仓库只有 90 天窗口的完整数据(2026-08-30 探针完成)。365 天回填在 channel 阶段第二页(startIndex 201)持续遇到官方 API 5xx"暂时不可用"(retryable),按检查点设计**重复执行同一命令即可续传直至完成**。注意:90 天同步已覆盖 365 天回填的检查点状态,重跑(不带 --days)会全新开始 365 天回填——属预期,页面数据会与已有行按 key 合并,不会重复。

- [ ] 在仓库根目录重复执行 `node .\dist\cli.js --json ops channel analytics-sync --config .\ytops-config.json --channel UClw-alcd2caLbNPabTtb0RQ`,每轮之间间隔数十秒;官方 5xx 抖动属预期,持续重试直至 state `status: "completed"`
- [ ] `ops channel coverage` 中 `analytics.core` 为 supported,`analytics.audience` 为 supported/partial
- [ ] `analytics-read --derived` 能返回约 365 行派生数据(RPM/赞踩比)
- [ ] 同步过程中如出现非 5xx 的错误(403/400),把 JSON 错误原文记录进本工票 Comments 再判断
