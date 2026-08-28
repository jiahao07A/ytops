# 07: 显式管理 Windows 定期任务

Type: task
Status: open
Labels: ready-for-agent
Blocked by: 06 跨进程互斥与有界并发

## What to build

让 Windows 用户可以显式安装、查看和停用触发一次性调度周期的系统定期任务，并在任何本机外部状态变更前看到准确的命令、频率和影响。

## Acceptance criteria

- [ ] `ops channel scheduler install`、`status` 和 `disable` 提供稳定 JSON 合同。
- [ ] 安装或变更前展示系统任务名称、触发频率、工作目录、实际 CLI 命令和本机影响，并要求明确确认。
- [ ] 安装、重复安装、状态查询和停用具有幂等行为，不创建重复或不可见任务。
- [ ] 系统任务只调用一次性 `scheduler run`，不注册自制守护进程或保存凭据到任务定义。
- [ ] 当前系统任务与配置发生漂移时，状态命令明确报告差异而不自动覆盖。
- [ ] 非 Windows 环境返回受支持性错误；普通 CI 使用可控系统调度适配器，不实际修改宿主机任务。

## Comments
