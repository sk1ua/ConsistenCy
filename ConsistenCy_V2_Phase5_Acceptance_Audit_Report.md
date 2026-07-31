# ConsistenCy V2 审计报告

## Phase 5 终验结论

**结论：不批准 Phase 5，必须 Redo。**

本次审计确认现有测试在当前机器上通过，但实现没有完全满足已批准的
`phase5_implementation_plan.md`。其中包括 3 项发布阻断问题、4 项可靠性问题和
1 组未兑现的验收门禁。不得将 Phase 5 标记为完成，也不得据此进入最终发布。

## 独立验证证据

- `npm run typecheck`：通过。
- `npm test`：通过，共 132 项：
  - API：111 项；
  - Web：6 项；
  - Schema：15 项。
- `python -m pytest -q`：115 项通过。
- `git diff --check`：退出码 0；仅报告 LF/CRLF 转换警告。
- 实际环境：Node `v25.8.1`、Python `3.11.9`。
- 计划规定的正式基线是 Node `22.x`、Python `3.12.x`，因此以上结果只能作为
  非基线预检，不能替代 Phase 7 基线验收。

---

## P0-1：HTTP 401 没有刷新 installation token，直接永久失败

### 位置

- `apps/api/src/publish/githubPublisher.ts:61-70`
- `apps/api/src/publish/worker.ts:142-155`
- `apps/api/src/github/auth.ts:10-13`
- `apps/api/src/github/auth.ts:46-60`
- `apps/api/src/server.ts:61-66`

### 问题

已批准计划明确要求：

> HTTP 401 Unauthorized -> Re-fetch token once; if second attempt fails ->
> PermanentPublishError.

当前 `classifyGitHubError()` 把第一次 401 直接转成
`PermanentPublishError`。`PublishWorker` 只获取一次 token、调用一次 publisher，
不存在 401 专用刷新分支。

此外，`@octokit/auth-app` 默认缓存 installation token。即使简单地再次调用当前
`getInstallationToken()`，也可能得到相同缓存 token；必须向 auth 调用传入
`refresh: true`。

### 触发条件

- installation token 被撤销；
- token 缓存失效但未到本地过期时间；
- GitHub 在 token 轮换窗口返回 401。

当前结果是第一次 401 就把 outbox 标记为 `failed`、job 标记为
`publish_failed`，违反既定重试策略。

### 确定修复

```diff
--- a/apps/api/src/github/auth.ts
+++ b/apps/api/src/github/auth.ts
@@
 export type AppAuth = (options: {
   type: "installation";
   installationId: number;
+  refresh?: boolean;
 }) => Promise<InstallationToken>;
@@
-async getInstallationToken(installationId: number, signal?: AbortSignal)
+async getInstallationToken(
+  installationId: number,
+  signal?: AbortSignal,
+  forceRefresh = false
+)
@@
-this.auth({ type: "installation", installationId })
+this.auth({ type: "installation", installationId, refresh: forceRefresh })
```

将 worker 的依赖改为：

```ts
tokenFetcher: (
  job: ReviewJob,
  signal: AbortSignal,
  options?: { forceRefresh?: boolean }
) => Promise<string>;
```

在 `processClaimedItem()` 中封装一次发布调用：

```ts
let token = await this.tokenFetcher(job, signal);
try {
  return await publishWith(token);
} catch (error) {
  if (!(error instanceof PublishError) || error.status !== 401) throw error;
  token = await this.tokenFetcher(job, signal, { forceRefresh: true });
  return await publishWith(token);
}
```

第二次 401 才进入永久失败分支。增加两个确定性测试：

- 第一次 publisher 返回 401，刷新后成功：`tokenFetcher === 2`、
  `publisher === 2`、最终 `succeeded`；
- 两次均返回 401：只计为一个完成失败 attempt，最终立即
  `publish_failed`。

---

## P0-2：所谓“崩溃窗口 + 第 2 页 marker”测试没有执行生产发布器

### 位置

- `apps/api/src/publish/worker.test.ts:231-277`
- `apps/api/src/publish/githubPublisher.ts:81-149`

### 问题

测试名声明覆盖：

> crash window idempotency & paginated marker search

但测试在 `worker.test.ts:236-253` 内重新实现了一个 `mockPublisher`。它自行创建
35 条内存评论并调用 `Array.find()`，完全没有调用生产
`publishToGitHub()`，也没有调用 Octokit `paginate()`、`updateComment()` 或
`createComment()`。

该测试也没有执行它声称的崩溃窗口：

1. 没有先成功执行 `createComment`；
2. 没有模拟在 `markPublishOutboxSuccess` 前崩溃；
3. 没有等待 lease 过期；
4. 没有由 Worker B 接管；
5. 没有验证 GitHub 侧始终只有一条评论。

因此，Phase 5 最关键的外部副作用幂等保证目前没有有效门禁。

### 确定修复

为生产发布器增加最小依赖注入，而不是在测试中重写算法：

```ts
export type GitHubCommentClient = {
  paginate: (...args: any[]) => Promise<Array<{ id: number; body?: string | null }>>;
  updateComment: (input: any) => Promise<{ data: { id: number } }>;
  createComment: (input: any) => Promise<{ data: { id: number } }>;
};

export async function publishToGitHub(
  options: PublishToGitHubOptions,
  deps: { createClient?: (token: string) => GitHubCommentClient } = {}
) {
  const client = deps.createClient?.(options.token) ?? createProductionClient(options.token);
  // 后续 fast path、paginate、update、create 全部只调用 client。
}
```

然后添加真实生产路径测试：

- 第一次调用 `publishToGitHub()`：`paginate` 返回无 marker，生产代码调用一次
  `createComment`；
- 模拟 store 的 success CAS 未执行或进程崩溃，保留 `leased`；
- 将 lease 设为过期，由 Worker B 领取；
- 第二次调用同一个 `publishToGitHub()`，fake client 的分页结果把 marker 放在
  第 2 页；
- 断言 `createComment` 总计恰好 1 次、`updateComment` 恰好 1 次、最终
  `external_id` 被保存。

同时分别覆盖：

- 有效 `externalId` 快速更新；
- `externalId` 返回 404 后进入 marker fallback；
- marker 不存在才创建新评论。

---

## P0-3：GitHub Actions 仍调用已删除的 V1 代码，并绕过 V2 Outbox

### 位置

- `.github/workflows/ci.yml:62-114`
- 已删除：`backend/cli.py`
- 已删除：`backend/src/review_suggestions.py`

### 问题

PR 事件下，CI 仍执行：

```yaml
python backend/cli.py pr-report ...
```

并导入：

```py
from src.review_suggestions import generate_review_comment
```

这两个文件在当前工作树中都已删除。任何 pull request 都会在
`ConsistenCy PR Risk Analysis` 步骤确定失败。

随后 `actions/github-script` 还会直接 `createComment`，这条路径绕过 Phase 5 的
outbox、lease、fencing、重试和 marker 幂等机制，与 V2 架构边界冲突。

### 确定修复

删除 `.github/workflows/ci.yml:62-114` 的三个旧步骤：

- `ConsistenCy PR Risk Analysis`；
- `Upload ConsistenCy report artifact`；
- `Post ConsistenCy Review Comment`。

V2 评论只能由 `PublishWorker -> publishToGitHub -> Outbox CAS` 链路发布。若未来
确实需要 CI 自审，必须新增调用当前 JSON-over-stdio 协议和 outbox 的独立入口，
不能恢复 V1 CLI 或直接调用 `github.rest.issues.createComment()`。

增加 CI 静态门禁：

```powershell
rg -n "backend/cli.py|review_suggestions|issues.createComment" .github
```

期望 0 匹配。

---

## P1-1：tokenFetcher 的错误可未经脱敏直接写入数据库

### 位置

- `apps/api/src/publish/worker.ts:169-190`
- `apps/api/src/jobs/sqliteJobStore.ts:328-338`
- `apps/api/src/jobs/sqliteJobStore.ts:384-399`
- `apps/api/src/jobQueue.ts:330-368`
- `apps/api/src/jobQueue.ts:375-410`
- `apps/api/src/publish/githubPublisher.ts:29-34`
- 已有共享工具：`apps/api/src/security/redact.ts:14-24`

### 问题

`PublishWorker` 使用：

```ts
const errorMessage = (err.message || String(caught)).slice(0, 500);
```

随后 store 仅再次 `.slice(0, 500)`，没有脱敏。`publishToGitHub()` 内的局部正则
只能处理它自己捕获的 GitHub 错误，无法保护 `tokenFetcher`、自定义 publisher、
数据库适配器或其他依赖抛出的错误。

如果这些错误消息包含 installation token、Authorization header 或私钥片段，
内容会进入：

- `publish_outbox.last_error`；
- `jobs.error`；
- `reports.github_comment_error`。

### 确定修复

只保留一个共享的入库清洗边界：

```ts
import { sanitizePublicError } from "../security/redact";

function sanitizePublishFailure(error: unknown, token?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join("[REDACTED]");
  return sanitizePublicError(message).slice(0, 500);
}
```

在 worker 中把 token 声明在 `try` 外，所有 `markRetry/markFailed` 只接收
`sanitizePublishFailure(caught, token)` 的结果。`classifyGitHubError()` 也应调用
同一个 `sanitizePublicError()`，删除其私有的三条不完整正则。

增加测试：tokenFetcher 和 publisher 分别抛出包含 `ghs_...`、
`github_pat_...`、`Bearer ...` 以及当前确切 token 值的错误；断言三个数据库字段
均不包含原始秘密。

---

## P1-2：SQLite claim 没有实现计划承诺的单语句原子领取

### 位置

- `apps/api/src/jobs/sqliteJobStore.ts:206-272`

### 问题

批准计划要求使用：

```sql
UPDATE publish_outbox
SET ...
WHERE id IN (SELECT ... LIMIT ?)
RETURNING *
```

当前实现先 `SELECT` 候选，再循环执行：

```sql
UPDATE publish_outbox SET ... WHERE id = ?
```

更新语句没有重复验证 outbox 状态、到期时间和 job 状态。虽然同一
`better-sqlite3` 连接内的同步事务可避免线程内交错，但在 WAL 模式的多进程/
多连接 worker 竞争下，该 read-then-write 形态会产生快照升级竞争
（`SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`），而不是计划承诺的单语句原子 claim。
当前测试也只有单连接串行接管，无法证明多 worker 领取行为。

### 确定修复

按已批准计划原样改成一条 `UPDATE ... WHERE id IN (...) RETURNING *`。随后在同一
事务中把返回行对应的 `awaiting_publish` job 更新为 `publishing`；对每个返回行
查询并断言 job 最终确实为 `publishing`，否则抛出并回滚整个 claim。

增加文件型 SQLite 双连接测试：

- 两个 `SQLiteJobStore` 指向同一个临时数据库；
- 同时竞争同一 pending item；
- 总领取数必须为 1；
- 不允许未处理的 `SQLITE_BUSY*`；
- `lease_generation` 只增加一次；
- expired lease 接管后只增加到下一代。

---

## P1-3：PublishWorker 停止时遗留永久 pending 的 pollLoop Promise

### 位置

- `apps/api/src/publish/worker.ts:57-73`
- `apps/api/src/publish/worker.ts:83-97`
- `apps/api/src/publish/worker.ts:111-117`

### 问题

`pollLoop()` 在以下 Promise 中等待：

```ts
await new Promise<void>((resolve) => {
  this.timer = setTimeout(resolve, this.pollIntervalMs);
});
```

`stop()` 只 `clearTimeout(this.timer)`，没有调用这个 Promise 的 `resolve`，也没有
保存或等待 `pollLoop()`。因此在 poll sleep 期间停止时，旧 loop 永远 pending。
每次 stop/start 都会留下一个闭包和 Promise。

另外：

```ts
void taskPromise.finally(...)
```

创建了一个未被处理的新 Promise。若 store mutation 抛错使
`processClaimedItem()` reject，该派生 Promise 会成为 unhandled rejection。

### 确定修复

保存 loop Promise 和 sleep resolver：

```ts
private loopPromise?: Promise<void>;
private wakePoll?: () => void;

start() {
  if (this.running) return;
  this.running = true;
  this.stopController = new AbortController();
  this.loopPromise = this.pollLoop();
}

async stop() {
  if (!this.running && !this.loopPromise) return;
  this.running = false;
  this.stopController?.abort();
  this.wakePoll?.();
  await this.loopPromise;
  await Promise.allSettled([...this.activeTaskPromises]);
  this.loopPromise = undefined;
}
```

任务追踪使用带 rejection handler 的 `then`，不要丢弃 `finally()` 返回值：

```ts
void taskPromise.then(
  () => this.activeTaskPromises.delete(taskPromise),
  error => {
    this.activeTaskPromises.delete(taskPromise);
    this.onError(error, item);
  }
);
```

测试必须覆盖：fake timer 下 sleep 中 stop、重复 start/stop、store mutation 抛错
且无 `unhandledRejection`。

---

## P1-4：计划列出的多项验收测试没有落实

### 位置

- `apps/api/src/db/migrations.test.ts:1-154`
- `apps/api/src/publish/worker.test.ts:29-340`

### 缺失门禁

- 没有“真实 0003 执行中失败并回滚”的测试；现有真实回滚测试只覆盖 0002。
- schema propagation 测试只验证初始 `pending`，未验证计划要求的 `leased` 和
  `retrying`。
- free-slots 测试使用 `concurrency = 1`，没有执行计划写明的并发 2/占满 2。
- auth abort 测试只直接调用 authenticator，没有验证“abort 后不发生 outbox
  mutation”。
- terminal job exclusion 只覆盖 `succeeded`、`cancelled`，漏掉
  `publish_failed`。
- 没有使用生产错误分类器验证 HTTP 404、422、429、403 rate limit、
  `Retry-After` 和 `x-ratelimit-reset`。
- 没有 401 刷新测试。

### 确定修复

逐条补齐 `phase5_implementation_plan.md` 的 8 类验收测试。测试名不得声明未执行
的生产行为；涉及 pagination、错误分类、marker 和 externalId 的测试必须调用
`publishToGitHub()`，不能在 mock 中复制同一算法。

---

## P2：仍存在可绕过 Outbox 的未引用发布入口

### 位置

- `apps/api/src/publish/publisher.ts`
- `apps/api/src/publish/dbPublisher.ts`
- `apps/api/src/github/comment.ts`

### 问题

这三个文件当前没有生产引用，但仍保留 V1 风格的“直接持久化 + 直接 GitHub
评论”入口。`publisher.ts` 还会吞掉持久化错误后继续发布，且不使用 lease、
fencing 或 marker crash recovery。

### 确定修复

在 Phase 6 删除这三个未引用文件，并增加依赖扫描，确保生产代码只存在一条评论
副作用路径：

```text
PublishWorker -> publishToGitHub -> fenced markPublishOutbox*
```

---

## Redo 完成门禁

只有同时满足以下条件，Phase 5 才可重新提交终验：

- 完成 P0-1、P0-2、P0-3；
- 所有写入发布错误的路径统一脱敏；
- SQLite claim 改为计划中的单语句 `UPDATE ... RETURNING`；
- `PublishWorker.stop()` 可等待真实 loop 退出，且无 unhandled rejection；
- 补齐计划列出的全部验收测试，特别是生产 publisher 的崩溃窗口测试；
- `npm run typecheck`、`npm test`、`python -m pytest -q`、
  `git diff --check` 全部通过；
- 最终 Phase 7 必须在 Node 22.x + Python 3.12.x 下重新执行完整基线。
