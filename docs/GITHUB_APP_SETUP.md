# GitHub App 设置

ConsistenCy 有两条独立的 GitHub 访问路径：

- **Webhook Review**：需要 GitHub App，用于接收事件和按既有策略发布评论；
- **Public Read**：只分析公开 PR，不需要安装 App，不发布评论。默认匿名读取，也可以配置服务端只读 PAT。

## Webhook Review 的必要设置

Webhook URL：

```text
https://your-server.example.com/github/webhook
```

| 权限 | 访问级别 | 用途 |
| --- | --- | --- |
| Metadata | Read | 读取仓库基础信息 |
| Contents | Read | 构建 PR workspace |
| Pull requests | Read and write | 读取 PR；Webhook 模式按策略发布评论 |

事件：`pull_request`、`push`、`installation`。

环境变量：

```bash
GITHUB_APP_ID=<your-app-id>
GITHUB_PRIVATE_KEY=/secure/path/private-key.pem
GITHUB_WEBHOOK_SECRET=replace-me
CONSISTENCY_API_TOKEN=replace-me
CONSISTENCY_ALLOWED_ORIGINS=https://your-web.example.com
```

不要把私钥提交到仓库；Settings 页面只显示 secret 是否配置，不会回显值。

## 不安装 App 的公开 PR 读取

如果只想分析公开 PR，不需要填写 `GITHUB_APP_ID` 或 `GITHUB_PRIVATE_KEY`：

```bash
CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED=true
CONSISTENCY_NOTEBOOK_ENABLED=true
GITHUB_PUBLIC_READ_TOKEN=
```

`GITHUB_PUBLIC_READ_TOKEN` 留空时使用匿名 GitHub API 和匿名 clone；配置本地只读 PAT 后，API 会使用 PAT 提高读取限额。可在 Settings 页面录入，值会写入本地加密配置；API 和 WebUI 之后只显示配置状态，不回显明文，也不会写入数据库、日志或评论。PAT 不能启用评论发布，认证失败也不会退回匿名读取。

公开 PR URL 必须指向公开仓库，例如：

```text
https://github.com/espnet/espnet/pull/6327
```

## 本地运行

启动步骤见 [Demo 与截图](demo.md)。API 默认监听 `127.0.0.1:8787`，Web 默认监听 `127.0.0.1:5173`。生产环境使用 HTTPS、secret manager、进程管理器和隔离 workspace。
