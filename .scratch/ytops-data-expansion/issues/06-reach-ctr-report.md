# 06: 曝光与点击率报表接入

Type: task
Status: resolved
Blocked by: 05

**What to build:** 频道运营者同步 reach 基础报表后，每期影片的每日曝光数与曝光点击率进入运营数据仓库，可经读取命令按视频与日期检索；接入采用频道级 reach 基础报表（日期×频道×视频行粒度）。同步幂等沿用；文档写明官方报表保留窗口（约 60 天、历史报告约 30 天）对同步节奏的约束；以真实频道验证该报表对频道主授权可用并记录结论。

## Answer

- 由并行 subagent 在独立 worktree 实现,5 个提交 rebase 后快进合并;README 冲突由协调者解决,合并后全树 333 测试通过。
- `ops channel reporting-read --report-type channel_reach_basic_a1 [--video <id>]` 输出规范化行(date/channelId/videoId/impressions/ctr);CSV 值原样保存不换算,CTR 小数/百分数口径写入文档;按族前缀 `channel_reach_basic_` 判定列语义,版本号演进不改列名。
- 报表类型采用字符集校验(沿 05)+ 登记常量承载产品语义,避免官方升版时白名单误拒;幂等导入与并存不覆盖均有测试;覆盖矩阵按类型呈现 reach 条目。
- 保留窗口(约 60 天/历史 30 天,建议至少每 30 天同步)写入 README/operations-boundary/architecture;real_integration_test.py 增加 reporting-read 探针(需真实凭据)。
- **探针待执行(需用户)**:reach 报表对频道主授权的真实可用性与 CSV 列名/CTR 形态以探针输出为准;若官方列名有出入仅需调整一处列映射。

- [ ] 同步完成后，日期×视频粒度的曝光数与曝光点击率可读取
- [ ] 与既有报表类型并存、互不覆盖
- [ ] 幂等导入保持（重复同步不产生重复行）
- [ ] 报表保留窗口约束写入文档，状态中的数据截至时间正确
- [ ] 真实频道验证通过并记录结论
- [ ] 库层测试覆盖报表行解析、键合并与幂等；CLI 测试覆盖；文档合同与中文门禁通过；verify 通过
