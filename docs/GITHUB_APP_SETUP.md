# GitHub App 设置

ConsistenCy 有两条独立的 GitHub 访问路径：

- **Webhook Review**：需要 GitHub App，用于接收事件和按既有策略发布评论；
- **Public Read**：只分析公开 PR，不需要安装 App，不发布评论。默认匿名读取，也可以配置服务端只读 PAT。

未安装 App 时，本地 `consistency review` 与公开 PR 分析照常可用；webhook 驱动的 PR 审查与 GitHub 评论发布不可用。生产环境下只设置 `GITHUB_WEBHOOK_SECRET` 而没有 App 凭据会被启动校验拒绝。

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

事件：只有 `pull_request` 会入队审查；`push`、`ping`、`installation` 等其它事件会被记录后忽略，不会触发审查。

环境变量：

```bash
GITHUB_APP_ID=<your-app-id>
GITHUB_PRIVATE_KEY=/secure/path/private-key.pem
GITHUB_WEBHOOK_SECRET=replace-me
CONSISTENCY_API_TOKEN=replace-me
CONSISTENCY_ALLOWED_ORIGINS=https://your-client.example.com
```

不要把私钥提交到仓库；`npm run config -- show` 只显示 GitHub App ID 与各 secret 是否已配置，不回显值。生产环境必须给 `CONSISTENCY_ALLOWED_ORIGINS` 写出显式 origin，不接受留空或 `*`。

## 不安装 App 的公开 PR 读取

如果只想分析公开 PR，不需要填写 `GITHUB_APP_ID` 或 `GITHUB_PRIVATE_KEY`：

```bash
CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED=true
CONSISTENCY_NOTEBOOK_ENABLED=true
GITHUB_PUBLIC_READ_TOKEN=
```

Notebook 目前只有服务端 API，仓库内没有随附的 Notebook 界面。

`GITHUB_PUBLIC_READ_TOKEN` 留空时使用匿名 GitHub API 和匿名 clone；配置本地只读 PAT 后，API 会使用 PAT 提高读取限额。可用 `npm run config -- set github.public-read-token <token>` 录入（`--clear` 清除，省略值时交互式隐藏输入），值会加密写入本地 settings；`npm run config -- show` 与 API 响应只显示是否已配置，不回显明文，也不会写入数据库、日志或评论。PAT 只用于读取，不能启用评论发布；读取凭据按 GitHub App → 只读 PAT → 匿名 的顺序依次尝试。

公开 PR URL 必须指向公开仓库，例如：

```text
https://github.com/espnet/espnet/pull/6327
```

## 本地运行

启动步骤见 [README](../README.md)。可用 `npm run dev:api` 启动 API daemon，默认监听 `127.0.0.1:8787`（`HOST`、`PORT` 可覆盖）。生产环境使用 HTTPS、secret manager、进程管理器和隔离 workspace。
