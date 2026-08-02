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
