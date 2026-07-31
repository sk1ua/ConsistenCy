# ConsistenCy V2 输出 Schema

ConsistenCy V2 的机器可读契约由 `@consistency/schema` 统一声明：

- `packages/schema/src/protocol.ts`：TypeScript 与 Python Engine stdio 进程协议契约（JSON-over-stdio snake_case wire contract）。
- `packages/schema/src/report.ts`：审查报告结构及度量指标契约。
- `packages/schema/src/review.ts`：审查计划 (Plan)、Agent 运行状态与 Finding 契约。
- `packages/schema/src/job.ts`：Job 状态与 Webhook 事件契约。

## PR Report 结构

V2 报告由 TypeScript `ReviewReport` Schema 约束，包含检索度量、Agent runs 记录与确凿/假设级别 Finding。

Schema 应保持强类型强约束，所有新增字段需使用 `zod` 进行定义与自动化测试校验。
