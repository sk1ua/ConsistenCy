# 输出 Schema

机器可读契约由 `@consistency/schema` 统一声明：

- `packages/schema/src/protocol.ts`：TypeScript 与 Python Engine 的 JSON-over-stdio wire contract，字段使用 `snake_case`。
- `packages/schema/src/report.ts`：ReviewReport、检索度量和 Finding。
- `packages/schema/src/review.ts`：审查计划、Agent run 和 Compose/Synthesizer 输出。
- `packages/schema/src/job.ts`：Job 状态与 Webhook 事件。

TypeScript 业务对象在 Schema 边界使用显式 `camelCase` ↔ `snake_case` 转换。新增字段必须通过 Zod 定义和自动化测试校验。

## ReviewReport 关注点

- `jobId`、仓库、PR、commit 和分析时间。
- 证据检索统计与 Evidence Pack 摘要。
- `findings`：风险等级、置信度、文件位置、证据和说明。
- `agentRuns`：每个阶段的状态、耗时、输入/输出摘要和错误。
- 发布状态与可追溯 metadata。

Risk score 用于审查注意力排序，不是自动化安全结论；UI 会把事实证据、模型推导和弱标签边界分开呈现。

## Audit run events 与 export

审计运行生命周期事件由 `auditRunEventSchema` 定义，字段为 `id`、`auditRunId`、`seq`、`eventType`、`payload`、`createdAt`。`seq` 是每个 run 从 1 开始、单调递增的持久化序号；事件按 `seq ASC` 返回，不能用时间戳替代排序。

`GET /audit-runs/:id/events` 返回 `{ events: AuditRunEvent[] }`。`GET` 与 `POST /audit-runs/:id/export` 是等价的只读读取方式，返回 `auditRunExportSchema` v1：`schemaVersion`、`generatedAt`、`run`、按 `seq` 升序的 `events`，以及可选的 `automation` 与 `workflowRuntimeRun` 摘要。重复读取同一持久化 run 使用 run 的创建时间作为 `generatedAt`，因此导出内容稳定。

进入 `executionError`、事件 payload 和导出的错误文本在持久化前统一净化：绝对路径替换为 `[PATH_REDACTED]`，credential/token/Bearer/Authorization 值替换为 `[REDACTED]`，换行折叠为空格并限制长度；公开契约不得包含本地路径、凭据或 stack 原文。
