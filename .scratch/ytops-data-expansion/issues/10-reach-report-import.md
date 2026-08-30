# 10: reach 报表首份报告导入

Type: task
Status: open
Label: ready-for-agent
Blocked by: none

**What to build:** reach 报表任务(`channel_reach_basic_a1`)已于 2026-08-30 创建并被 CLI 正确复用(409→查回现有任务);官方生成首份报告最长需要 48 小时,生成前 `reporting-status` 可能报"Internal error encountered"(retryable)。首份报告就绪后导入即可。

- [ ] 在仓库根目录执行 `node .\dist\cli.js --json ops channel reporting-sync --config .\ytops-config.json --channel UClw-alcd2caLbNPabTtb0RQ --report-type channel_reach_basic_a1`;若报 Internal error,间隔数小时后重试(任务不会重复创建)
- [ ] `ops channel reporting-status --report-type channel_reach_basic_a1` 显示 ready/imported
- [ ] `ops channel reporting-read --report-type channel_reach_basic_a1` 返回 date/channelId/videoId/impressions/ctr 规范化行
- [ ] 核对官方 CSV 列名与 CTR 形态(小数/百分数);若与 `REACH_BASIC_COLUMN_MAP` 不符,只需调整该映射一处
- [ ] `ops channel coverage` 中 `reporting.async`(scope 报告类型 channel_reach_basic_a1)为 supported
- [ ] 提醒:Reporting 报表约 60 天/历史 30 天可下载,建议每周同步一次防断档
