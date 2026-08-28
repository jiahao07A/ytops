# 04: 以 Inventory 贯通统一同步任务合同

Type: task
Status: claimed
Blocked by: None (can start immediately)

## What to build

以频道、上传播放列表和视频元数据同步作为首个完整 tracer，为频道运营者建立统一、可恢复且兼容旧运营数据仓库的同步任务身份、状态和 CLI 退出语义。

## Acceptance criteria

- [ ] 同步任务身份至少包含频道接入、数据源和同步范围；不同身份不得共享检查点或规范化结果。
- [ ] Inventory 从官方 Google 客户端的窄 provider 完整同步频道、上传播放列表和视频分页，并按资源身份幂等合并。
- [ ] `queued`、`running`、`waiting`、`retrying`、`partial`、`failed` 和 `completed` 具有稳定 JSON 投影及时间、重试和错误字段。
- [ ] 终止性失败返回 `ok: false` 和非零退出码；非终止状态携带结构化任务状态，不能被误认作完成。
- [ ] 只请求无法独立执行的同步范围时返回输入错误或部分覆盖，不得以空数据标记完成。
- [ ] 网络中断或进程终止后从已确认检查点恢复，默认 CLI 范围不会意外重置检查点。
- [ ] 既有配置、状态和规范化数据通过幂等兼容迁移继续可读，失败迁移保留原数据。

## Comments
