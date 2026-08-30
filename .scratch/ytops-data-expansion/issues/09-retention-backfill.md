# 09: 留存曲线回填 60 个视频

Type: task
Status: open
Label: ready-for-agent
Blocked by: none

**What to build:** 首轮留存同步只完成 1/61 个视频(该视频官方返回空数据点,已按"完成但空曲线"语义记录),其余 60 个在 pending 清单中,因官方 API 对留存查询间歇性 5xx 而暂停。检查点已保留,**重复执行同一命令即按 pending 清单续传**。

- [ ] 在仓库根目录重复执行 `node .\dist\cli.js --json ops channel retention-sync --config .\ytops-config.json --channel UClw-alcd2caLbNPabTtb0RQ`,直至 state `status: "completed"` 且 `pendingVideoIds` 为空
- [ ] `ops channel coverage` 中 `retention.curve` 为 supported(若部分视频官方确无数据点,partial 亦可接受并在 Comments 列出这些视频 ID)
- [ ] 抽查 2-3 个有观看量的视频:`retention-read --video <id>` 返回约 100 个进度点,数值可超过 1 如实呈现
- [ ] 个别视频(如 Shorts)官方确无留存数据,记为 completed+空曲线属正常语义,不算失败
