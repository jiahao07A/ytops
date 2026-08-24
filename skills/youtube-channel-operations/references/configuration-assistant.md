# 配置辅助协议

这个参考文件定义配置辅助 skill 的唯一编排顺序。skill 可以解释和建议配置，但不能代替用户确认，也不能读取或保存 OAuth 秘密。

## 意图路由

| 用户表达           | 只读准备                                            | 需要确认的写入                       | 写入后校验                         |
| ------------------ | --------------------------------------------------- | ------------------------------------ | ---------------------------------- |
| 初始化频道接入     | `config explain`、`config validate`                 | `config set-channel --channel <id>`  | `config validate`                  |
| 设置每日同步或配额 | `config validate`、展示当前值                       | `config set-global` 或 `set-channel` | `config validate`                  |
| 新建分析配置       | `config explain`、校验指标/维度/时间范围            | `config set-profile`                 | `config validate --profile <name>` |
| 检查或修复错误     | `config validate`、逐项解释错误                     | 只修改用户确认的字段                 | 再次 `config validate`             |
| 准备 OAuth         | 展示 Google Cloud、同意屏幕、回调地址和环境变量指引 | 不代替授权                           | 用户自行完成 `ops channel auth-*`  |

## 强制流程

1. 读取并校验现有配置；配置不存在时只提出初始化命令。
2. 将用户意图转换为明确的全局、频道或分析档案字段。
3. 展示变更前值、变更后值、受影响的配置路径和校验结果。
4. 在用户明确确认前不得调用任何 `config set-*` 命令。
5. 写入后立即运行 `config validate`，失败时报告具体路径并停止后续操作。
6. 对 OAuth 只提供前置指引；不得要求用户在聊天中发送客户端秘密、授权码、state、access token 或 refresh token。

## 机器可读结果

skill 应优先调用 `node .\\dist\\cli.js --json`，并把结果归一为：

```json
{
  "action": "propose | validate | apply | guide-oauth",
  "configPath": "<用户明确提供的路径>",
  "changes": [],
  "confirmed": false,
  "validation": { "ok": false, "message": "" }
}
```

`confirmed` 为 `false` 时，`action` 不得为 `apply`。任何错误都必须保留 CLI 的失败状态，不得把失败改写成成功或隐藏敏感字段。

## 越权边界

- 不调用 `ops channel auth-complete`、`sync` 或任何未来写入命令代替用户执行外部副作用。
- 不把 `yt-dlp` 当作官方频道 API，不读取浏览器 Cookie。
- 不修改未出现在差异预览中的字段，不批量清理配置目录。
