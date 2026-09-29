# 已修复缺陷清单（历史）

> **历史记录。** 本文件保留 ConsistenCy v3 时期审计修复中**至今仍然成立**的结论，供回归防护作背景参考。
> 当时的验证环境、批次排期、日志与截图路径已全部删除。任何能力是否现存、行为是否与描述一致，
> 一律以当前代码与 `npm run verify` 为准。

审计依据：《ConsistenCy-v3-architecture-audit》（2026-09-13，基准提交 `78dc904f522ec3e31d7ef70ae7a940880d4078e5`）。

## 内容策略：分析字节与模型可见内容分离（P0-01）

- `packages/schema/src/content.ts:25` `isSecretPath` 是唯一的秘密路径判定实现。
- `packages/workload-review/src/context/content-policy.ts:64` `redactModelVisibleText`（保持行数、幂等）；`:143` `dropSecretPathDiffSections`（按文件分段整段删除秘密路径的 diff，fail-closed，兼容 git 与本地两种头格式并容忍 CRLF）；`:216` `applyModelContentPolicy` 是模型可见投影的入口。
- `packages/workload-review/src/workload/review-workload.ts:311` 拆出 `analysisContext`（原始字节，供确定性分析与证据）与 `agentContext`（策略投影，供 Supervisor、专项 agent、Synthesizer）；prompt 层再各过一次脱敏（`packages/workload-review/src/agents/prompts.ts:182`、`packages/workload-review/src/supervisor/supervisor.ts:117`、`packages/workload-review/src/synthesis/synthesizer.ts:150`）。
- 其他模型入口共用同一策略：`apps/api/src/review/llm/hostInvoke.ts:22` `hostVisiblePrompt`。

## 覆盖度诚实（P1-05 / P1-09）

- `packages/schema/src/report.ts:14` `reviewCoverageSchema`（`outcome`、`enabledAgents`、`failedAgents`、`plannerFailed`、`synthesizerFailed`、可选 `deterministicFailed`）；`packages/schema/src/report.ts:180` 报告 `coverage` 可选，以兼容旧报告。
- 专项 agent 全失败不再呈现为“干净通过”：coverage 降级时摘要带确定性警告前缀，findings=0 的兜底文案不得表述为通过；`packages/workload-review/src/workload/review-workload.ts:589` 以 `workflowStepsIncomplete` 置 `deterministicFailed`，`apps/cli/src/report.ts:137` 据此在终端渲染确定性步骤未全部成功。

## 取消与关停（P1-07① / P1-07③）

- `packages/workload-review/src/workload/review-workload.ts:134` `ReviewCancelledError`；`:176` run 级 `AbortController`；`:198` `cancelRun()` 同时停止后续准入并中断在飞调用；run 前取消在入口即拒，不产出报告。provider 请求携带 `signal`，中止不消耗修复重试。
- `apps/api/src/review/jobCancel.ts:37` `cancelReviewJob`；HTTP `POST /jobs/:id/cancel`（未知 404 / 终态 409 / 取消 200），先通知 live run 再落库。
- 关停：`ReviewWorker.stop({ ms, onExpiry })` 宽限到期触发 `onExpiry`，第二窗口结束后放弃等待；`apps/api/src/config/env.ts:85` `CONSISTENCY_SHUTDOWN_GRACE_MS` 默认 30000，范围 1000–600000；`apps/api/src/server.ts:782` 接线。

## 重启恢复与终态撤权（P1-07② / P1-02）

- `apps/api/src/jobQueue.ts:130`（内存）与 `apps/api/src/jobs/sqliteJobStore.ts:632`（SQLite）`failInterruptedRunningJobs()`：启动时把所有 running 置 failed，不留时间窗盲区；`apps/api/src/server.ts:131` 调用。
- `packages/workload-review/src/workload/review-workload.ts:231` `#revokeIssuedCapabilities()` 在成功、失败、取消三条终态路径全量撤权（幂等）；同文件 `:658` 结果携带 `capabilitiesIssued` / `capabilitiesRevoked`。

## 工作树快照钉住（P1-01）

- `packages/schema/src/context.ts:54` `reviewSnapshotSchema`；迁移 `0023_job_review_snapshots`（`apps/api/src/db/migrations.ts:1250`）与 `0024_review_snapshot_contents`（`apps/api/src/db/migrations.ts:1270`）。
- `apps/api/src/review/jobDiff.ts:108`：工作区缺失一律 `{ files: [], available: false, pinned: false }`，生产路径不合成替代 diff；同文件 `:47` `pinned` 表示差异是否来自审查时快照或已钉住 SHA，无快照的旧工作树 job 回退活读并标 `pinned: false`。
- 未解决边界：快照未覆盖的文件在 HEAD 推进后仍可能按索引时刻内容读取，属部分一致。

## 证据锚点与预算记账（P1-06② / P2-04）

- `packages/workload-review/src/agents/grounding.ts:88`：`confirmed` 若与证据记录无交集则降级为 `likely`；证据不全不得标 confirmed。
- review 的 `llm.invoke` 签发预算 `{ maxTokens: 250_000, maxCalls: 32 }`，gateway 记账不再空转。

## LLM 未配置时的失败方式

- 未配置 LLM provider 时，`apps/api/src/http.ts` 的各模型入口（local review、公开 PR 分析、workflow copilot）统一以 `LLM_NOT_CONFIGURED` + HTTP 503 拒绝；产品运行时不存在 demo/mock 模式，CI 内部的 `LLM_PROVIDER=mock` double 不是产品设置项。
