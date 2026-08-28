# 18: 真实 Reporting 恢复与导入验收

Type: task
Status: open
Labels: ready-for-human
Blocked by: 11 Reporting CSV 与持续日报导入; 13 事实查询、覆盖矩阵与证据生命周期; 17 真实 Reporting 等待状态验收

## What to build

在官方报告就绪后，从 17 保存的等待状态继续下载和导入真实日报，验证重复执行幂等、事实可核验，并证明同一 job 后续仍会发现新日报。

## Acceptance criteria

- [ ] 仅在官方报告已经就绪后开始本票据；未就绪时保持 open 并保留原等待状态。
- [ ] 新上下文从既有 job 和检查点继续，不重新创建重复 Reporting job。
- [ ] 真实日报成功下载、保存为受控原始证据并导入规范化事实，范围和数据截至时间正确。
- [ ] 重复执行不会产生重复事实或重复已导入记录。
- [ ] 导入完成后任务继续安排后续报告检查，不因首次 imported 状态永久停止。
- [ ] 事实查询和覆盖矩阵能够定位脱敏证据摘要，并准确表达 Reporting 覆盖状态。
- [ ] Git、issue 和普通日志中不包含真实报告内容、频道数据、凭据或 Authorization 头。

## Comments
