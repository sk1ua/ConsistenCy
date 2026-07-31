# 架构

## 组件

- `apps/api`：HTTP API、GitHub App webhook、worker、SQLite。
- `apps/web`：React 仪表盘。
- `packages/schema`：共享 zod schema。
- `engine`：Python 确定性多信号分析引擎与协议 runner。

## 数据流

```text
GitHub webhook -> job queue -> PR context -> review workflow (TS Orchestration + Python Engine stdio) -> report -> outbox -> GitHub comment
```

报告会先持久化并写入 publish_outbox，再由 PublishWorker 异步发布 GitHub 评论。评论发布失败不会让已完成的审查任务失败。
