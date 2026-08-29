# ADR 0001：公开检索的显式 opt-in YouTube cookie 支持

- 状态：已接受
- 日期：2026-08-29
- 影响范围：`src/lib/yt-dlp.ts`、`src/lib/config.ts`、`src/cli.ts`、`src/lib/doctor.ts`、README、skills 文档

## 背景

2026-08 起本机出口 IP 访问 YouTube 公开内容时被 "Sign in to confirm you're not a bot" 反机器人检查拦截，`search`、`inspect`、`captions list` 在无凭据状态下全部失败（真实集成测试 `scripts/real_integration_test.py` 暴露）。yt-dlp 官方缓解阶梯为：升级 yt-dlp、PO Token、更换 IP、提供登录 cookie。本仓库此前在 README、architecture 与 skills 中把"不读取浏览器 Cookie"列为默认安全边界；本决策显式推翻该边界中的"一律禁止"部分，代之以"默认关闭、显式 opt-in"。

## 决策

1. cookie 访问保持**默认关闭**：`--ignore-config`、`YTDLP_IGNORE_CONFIG=1` 与 doctor 安全默认值语义不变；无任何显式来源时行为与历史版本完全一致。
2. 提供三层**显式 opt-in** 来源，同一机制内按优先级解析：命令行标志（`--cookies <file>`、`--cookies-from-browser <spec>`）> 环境变量（`YTOPS_YTDLP_COOKIES_FILE`、`YTOPS_YTDLP_COOKIES_FROM_BROWSER`）> 频道运营配置 `global.cookies`（仅通过显式 `--config <path>` 读取，无隐式默认路径）。
3. cookie 文件与浏览器来源**互斥**：解析后两种机制同时存在时返回 `USER_INPUT` 错误并指明冲突来源；与 yt-dlp 自身"只能使用其中一种"的行为一致。
4. 浏览器 spec 做词法白名单校验后**原样透传**，不解析 keyring/profile/container 语法。Windows 上 Chrome/Edge 127+ 受 App-Bound Encryption 限制，文档与 doctor guidance 推荐 firefox 或导出的 Netscape 格式 cookie 文件。
5. cookie 文件**内容**按受保护凭据对待：绝不进入配置、日志、JSON 输出或 Git；配置只允许保存本机路径（结构化路径校验，拒绝凭据形状文本，`.gitignore` 已有 `cookies*.txt` 等模式）。
6. cookie 文件路径按 CLI 进程的当前工作目录解析（配置中的相对路径不相对于配置文件位置）；命令行 `--cookies` 额外接受裸文件名，`global.cookies.file` 配置侧仍要求结构化的相对或绝对路径。

## 备选方案

- **PO Token / `--extractor-args` 透传**：依赖外部 bgutil 服务与客户端选择，复杂度高且在 IP 信誉已受损时无效；不在本期范围。
- **更换 IP / 代理**：官方最推荐的做法，但属于部署环境决策，不是 CLI 能力。
- **维持完全禁止 cookie**：公开链路在本机持续不可用，skills 编排失去公开检索能力。

## 风险与后果

- 使用登录 cookie 有账号风控/封禁风险（官方明确警告）：文档与 doctor guidance 建议使用专用小号；不加运行时确认标志以保持命令摩擦最低（用户决策），下载仍需 `--rights-confirmed`。
- `--cookies` 的文件路径会出现在本机进程参数中（yt-dlp 约定如此），文件内容不会；`--cookies-from-browser` 只读取浏览器数据库副本，Windows 上 Chrome 运行时偶发锁库失败，需退出浏览器或改用导出文件。
- doctor 新增 `cookiesFileConfigured` / `cookiesFromBrowserConfigured` 布尔字段，`safeDefaults.cookieAccess` 变为 `"disabled" | "environment-opt-in"`；只报状态，不报路径或值。
- cookie 文件需为 Netscape 格式；CRLF 换行问题会导致 HTTP 400，由 yt-dlp 错误映射自然暴露。
