# 架构

## 组件

- `apps/api`：HTTP API、GitHub App webhook、worker、SQLite。
- `apps/web`：React 仪表盘。
- `packages/schema`：共享 zod schema。
- `backend`：Python 确定性分析器、检索、CLI、评估。

## 数据流

```text
GitHub webhook -> job queue -> PR context -> review workflow -> report -> dashboard/comment
Python CLI -> PR report -> retrieval packs -> consensus -> markdown/schema output
```

报告会先持久化，再发布 GitHub 评论。评论发布失败不会让已完成的审查任务失败。
