# ConsistenCy V2 审计报告

## Phase 4 Redo 验收结论

**结论：BLOCK。Phase 4 暂不批准进入 Phase 5。**

本轮修复已经正确完成全局 finding 预算、canonical score/risk、Outbox 原子事务、报告可读状态和 UI 状态展示等主要工作；但仍存在 1 个跨 Store 契约阻断、2 个确定的幂等/数据完整性问题，以及 1 个关键迁移测试缺口。

不得以当前实现开始编写依赖 `PublishOutboxItem` 的 `PublishWorker`，否则 Phase 5 会建立在错误的字段类型上。

## 独立验证结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| API Vitest | 24 files / 103 tests PASS |
| Web Vitest | 2 files / 6 tests PASS |
| Schema Vitest | 2 files / 15 tests PASS |
| TypeScript 合计 | 28 files / 124 tests PASS |
| `python -m pytest -q` | 115 tests PASS |
| `git diff --check` | PASS；仅输出 LF/CRLF 转换警告 |
| 实际运行环境 | Node 25.8.1 / Python 3.11.9；不是最终基线环境 |

注意：原完成报告中的“24 个文件、103 项”只是 API workspace 的统计，不是根目录 `npm test` 的完整总数。

## P0-01：SQLite Outbox 返回值违反共享 Schema

### 证据

- `packages/schema/src/job.ts:42-48`
  - `id` 被定义为 `number`。
  - `nextAttemptAt` 被定义为非空 `string`。
- `apps/api/src/db/migrations.ts:104-112`
  - SQLite 的 `id` 是 `TEXT PRIMARY KEY`。
  - `next_attempt_at` 是可空 `TEXT`。
- `apps/api/src/jobs/sqliteJobStore.ts:229-233`
  - 实际插入 `id = "outbox_<uuid>"`。
  - INSERT 没有写入 `next_attempt_at`，因此首轮记录为 `NULL`。
- `apps/api/src/jobs/sqliteJobStore.ts:253,258`
  - 行类型用断言把 `id` 伪装成 `number`、把 `next_attempt_at` 伪装成 `string`。
- `apps/api/src/jobs/sqliteJobStore.test.ts:180-182`
  - 测试只查询原始 SQL 行并检查 `status/target`，没有调用 `getPublishOutbox()`，也没有使用 `publishOutboxItemSchema.parse()`。

独立运行时复现得到：

```json
{
  "item": {
    "id": "outbox_2ac53093-9c5a-4d4c-b24d-b791e326ee53",
    "status": "pending",
    "nextAttemptAt": null
  },
  "schemaAccepted": false,
  "schemaIssues": [
    {"path": ["id"], "message": "Expected number, received string"},
    {"path": ["nextAttemptAt"], "message": "Expected string, received null"}
  ]
}
```

### 触发条件与影响

任何通过 `SQLiteJobStore.getPublishOutbox()` 读取首轮待发布任务的代码都会得到一个不满足其 TypeScript 声明和共享 Zod Schema 的对象。

Phase 5 一旦在 Worker 边界执行 Schema 校验，所有 SQLite 待发布任务会立即失败；若不校验，则 Worker 会在错误类型假设上继续运行。InMemory Store 不会暴露同样的行为，因此测试环境和生产 SQLite 行为发生分裂。

### 确定修复

以现有迁移中已经确定的 `TEXT` 主键为准，将共享契约统一为字符串 ID。`next_attempt_at` 的策略必须只有一个；推荐新建 pending 记录时明确写入当前时间，同时让读取 Schema 反映数据库可空性。

```diff
// packages/schema/src/job.ts
 export const publishOutboxItemSchema = z.object({
-  id: z.number().int(),
+  id: z.string().trim().min(1),
   jobId: z.string().trim().min(1),
   target: z.string().trim().min(1),
   status: publishOutboxStatusSchema,
   attemptCount: z.number().int().min(0),
-  nextAttemptAt: z.string(),
+  nextAttemptAt: z.string().datetime().nullable(),
   leaseOwner: z.string().nullable().optional(),
   leaseExpiresAt: z.string().datetime().nullable().optional(),
   lastError: z.string().nullable().optional(),
-  createdAt: z.string(),
-  updatedAt: z.string()
+  createdAt: z.string().datetime(),
+  updatedAt: z.string().datetime()
 }).strict();
```

```diff
// apps/api/src/jobs/sqliteJobStore.ts
 INSERT INTO publish_outbox (
-  id, job_id, target, status, attempt_count, created_at, updated_at
-) VALUES (?, ?, 'github_comment', 'pending', 0, ?, ?)
+  id, job_id, target, status, attempt_count,
+  next_attempt_at, created_at, updated_at
+) VALUES (?, ?, 'github_comment', 'pending', 0, ?, ?, ?)
 ON CONFLICT(job_id, target) DO NOTHING
-`).run(`outbox_${randomUUID()}`, id, now, now);
+`).run(`outbox_${randomUUID()}`, id, now, now, now);
```

同时修正 SQLite 行类型：

```diff
-id: number;
+id: string;
 ...
-next_attempt_at: string;
+next_attempt_at: string | null;
```

InMemory Store 也必须使用同一种 ID：

```diff
-private outboxIdSeq = 1;
 ...
-id: this.outboxIdSeq++,
+id: `outbox_${randomUUID()}`,
```

最后，在两个 Store 的返回边界都执行共享 Schema 校验，禁止再次用类型断言掩盖数据库值：

```ts
return rows.map(row => publishOutboxItemSchema.parse({
  id: row.id,
  jobId: row.job_id,
  target: row.target,
  status: row.status,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
}));
```

必须新增一个参数化 Store parity 测试，对 InMemory 与 SQLite 分别断言：

```ts
expect(publishOutboxItemSchema.parse(store.getPublishOutbox(job.id)[0])).toMatchObject({
  jobId: job.id,
  target: "github_comment",
  status: "pending",
  attemptCount: 0
});
```

## P1-01：canonical summary/recommendations 在 LLM 成功路径仍会丢失

### 证据

- `apps/api/src/review/agents/synthesizer.ts:22-29`
  - canonical summary 与 recommendations 只被放入 fallback 文本。
- `apps/api/src/review/agents/synthesizer.ts:37-46`
  - 成功调用 LLM 后，`summary = result.data.summary` 无条件覆盖 fallback。
- `apps/api/src/review/agents/synthesizer.test.ts:42,70`
  - 测试中的 LLM 返回文本没有包含 Python 的 canonical summary，也没有包含两条 recommendations。
  - 测试仍断言最终 report.summary 等于该 LLM 文本，反而证明 canonical 文本在成功路径丢失。

### 触发条件与影响

只要 LLM 忽略提示词、压缩掉某条建议或返回泛化摘要，Python `compose_review` 的 summary/recommendations 就不会进入最终 `ReviewReport`。提示词不是数据完整性约束，不能承担“完整传递”的职责。

score/riskLevel 当前仍保持 canonical，因此这不是评分真相源回退；问题是 canonical 解释和修复建议会丢失。

### 确定修复

LLM 只能增加一段补充摘要，不得替换 canonical 内容：

```diff
 const result = await dependencies.provider.generateSummary(...);
-summary = result.data.summary;
+const llmSummary = result.data.summary.trim();
+summary = [
+  canonicalSummary,
+  ...(llmSummary ? [`LLM synthesis: ${llmSummary}`] : []),
+  ...recommendations.map(item => `Recommendation: ${item}`)
+].filter(Boolean).join("\n\n");
 tokenUsage = result.tokenUsage;
```

成功路径测试必须断言最终报告同时保留所有 canonical 内容：

```ts
expect(result.report?.summary).toContain(mockComposedReview.summary);
for (const recommendation of mockComposedReview.recommendations) {
  expect(result.report?.summary).toContain(recommendation);
}
expect(result.report?.summary).toContain("LLM Synthesized summary");
```

## P1-02：终态/发布中 replay 并不是“complete no-op”

### 证据

- `apps/api/src/jobQueue.ts:177-188`
  - `reviewReportSchema.parse(result)` 在读取 Job 和终态检查之前执行。
- `apps/api/src/jobs/sqliteJobStore.ts:200-211`
  - SQLite Store 同样先 parse，再检查 `publishing/succeeded/publish_failed`。
- 当前测试只使用合法 report 重放，未验证终态调用是否真正忽略 payload。

独立运行时复现：把 Job 设为 `publishing` 后调用
`persistReportAndEnqueuePublish(jobId, {} as any)`，结果是 `ZodError`，不是 no-op。

### 触发条件与影响

在至少一次成功持久化后，重复消息携带陈旧、损坏或版本不兼容的 report 时，即使 Job 已经处于 `publishing/succeeded/publish_failed`，调用仍会失败。该行为违反 Phase 4 计划中“terminal/publishing status complete no-op”的幂等约定。

### 确定修复

两个 Store 都必须按同一顺序执行：

1. 查询 Job，不存在则抛 `Job not found`。
2. 若为 `publishing/succeeded/publish_failed`，立即返回现有 Job。
3. 校验可迁移状态。
4. 解析 report。
5. 执行原子写入。

```diff
 persistReportAndEnqueuePublish(id: string, result: ReviewReport) {
-  const validatedReport = reviewReportSchema.parse(result);
   const job = this.jobs.get(id);
   if (!job) throw new Error(...);
   if (isTerminalOrPublishing(job.status)) return job;
   if (!isPersistable(job.status)) throw new Error(...);
+  const validatedReport = reviewReportSchema.parse(result);
   // mutate only below this line
 }
```

SQLite 版本应把查询、终态判断、Schema parse 与写入都放在同一 transaction 回调中。

新增测试必须对 `publishing`、`succeeded`、`publish_failed` 三种状态逐一执行：

```ts
expect(() =>
  store.persistReportAndEnqueuePublish(job.id, {} as ReviewReport)
).not.toThrow();
expect(store.get(job.id)).toEqual(before);
expect(store.getPublishOutbox(job.id)).toEqual(outboxBefore);
```

## P1-03：所谓“0002 中途失败测试”没有运行真实 0002 迁移

### 证据

- `apps/api/src/db/migrations.test.ts:119` 的测试名声称验证 0002 中途失败。
- `apps/api/src/db/migrations.test.ts:132-137` 实际构造的是另一个 `0002_faulty`：

```ts
db.exec("CREATE TABLE publish_outbox (id TEXT PRIMARY KEY);");
throw new Error("Simulated migration failure in 0002");
```

它没有执行真实 `0002_publish_outbox` 的以下高风险步骤：

- 创建并复制 `jobs_v2`；
- `DROP TABLE jobs`；
- `ALTER TABLE jobs_v2 RENAME TO jobs`；
- 重建 index；
- 创建完整 Outbox；
- `foreign_key_check`。

### 影响

该测试只能证明“单个 CREATE TABLE 后抛错会回滚”，不能证明真实的 jobs 表重建流程在失败时能恢复旧表、旧 CHECK constraint、索引和关联数据。测试名称与完成报告夸大了覆盖范围。

### 确定修复

把 `0002_publish_outbox` 的 DDL 拆成可单独执行的阶段函数，并在测试中对真实步骤注入 checkpoint：

```ts
type MigrationCheckpoint = (step: string) => void;

export function migratePublishOutbox(
  database: ConsistencyDatabase,
  checkpoint: MigrationCheckpoint = () => {}
): void {
  database.exec("CREATE TABLE jobs_v2 (...)");
  database.exec("INSERT INTO jobs_v2 SELECT * FROM jobs");
  checkpoint("after_jobs_copy");
  database.exec("DROP TABLE jobs");
  checkpoint("after_jobs_drop");
  database.exec("ALTER TABLE jobs_v2 RENAME TO jobs");
  // recreate indexes and publish_outbox, then foreign_key_check
}
```

生产 migration 调用默认 checkpoint；测试在 `after_jobs_drop` 抛错，然后断言：

- 原 `jobs` 表及历史行完整恢复；
- 原 0001 status CHECK 仍有效；
- `agent_runs/reports/webhook_deliveries` 完整；
- `jobs_v2`、`publish_outbox` 不存在；
- 0002 未写入 `schema_migrations`；
- `PRAGMA foreign_keys = 1`；
- 重新运行真实 0002 可以成功。

## 已确认修复正确的部分

- `buildComposeReviewFileResults()` 对所有文件实行全局 20 条上限，并将每条静态/LLM finding 截断至 500 字符。
- 超过 finding 配额的文件仍保留 `risk_score`。
- final report 的 `score/riskLevel` 强制来自 Python `composedReview`。
- `wireAnalyzeSuccessSchema.files` 不再隐式默认空数组。
- SQLite 的 report/outbox/status 三步写入位于同一 transaction，触发器失败测试证明业务写入会整体回滚。
- Review Graph 在 enqueue Outbox 后结束，没有调用 GitHub 发布 API。
- Job 统计已将 `awaiting_publish/publishing` 归入 running，仅把 `succeeded` 计为成功。
- 新 Job 状态的前端翻译已补齐。

## Redo 验收门禁

- [ ] InMemory 与 SQLite Outbox 返回值都能通过同一个 `publishOutboxItemSchema`。
- [ ] SQLite 首轮 pending 任务的 `id`、`nextAttemptAt` 与共享类型一致。
- [ ] LLM 成功与失败两条路径都保留 canonical summary 和全部 recommendations。
- [ ] 三种 terminal/publishing 状态对任意 report payload 都是真正 no-op。
- [ ] 迁移失败测试执行真实 jobs_v2 copy/drop/rename 路径。
- [ ] `npm run typecheck`、根目录 `npm test`、`python -m pytest -q`、`git diff --check` 全部通过。
- [ ] 最终基线必须另行在 Node 22.x + Python 3.12.x 下验证。

以上门禁全部满足后，再申请 Phase 4 终验；当前不得进入 Phase 5。
