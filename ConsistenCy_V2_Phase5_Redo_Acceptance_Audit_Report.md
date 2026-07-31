# ConsistenCy V2 审计报告

## Phase 5 Redo 终验结论

**结论：不批准。Phase 5 仍需一次定点 Redo。**

当前生产实现已经完成 401 force-refresh、单语句 SQLite claim、CI 旧步骤移除和
基本 shutdown 屏障，但仍有 1 项真实运行时缺陷，以及 4 项以测试替身代替生产
路径的验收缺口。不得将 `task.md` 中的 Phase 5 标记为 Approved。

## 独立验证结果

- `npm run typecheck`：通过。
- `npm test`：通过：
  - API：27 个文件，120 项；
  - Web：2 个文件，6 项；
  - Schema：2 个文件，15 项；
  - 工作区总计：31 个文件，141 项。
- `npm run build`：通过，Web 生产构建成功。
- `python -m pytest -q`：115 项通过。
- `git diff --check`：退出码 0，仅有 LF/CRLF 转换警告。
- 当前环境：Node `25.8.1`、Python `3.11.9`，不是 Phase 7 正式基线。

测试全绿只能证明现有断言成立，不能弥补下列未执行的验收路径。

---

## P0-1：任务 rejection handler 仍未实现，存在 unhandledRejection

### 位置

- `apps/api/src/publish/worker.ts:125-131`
- `apps/api/src/publish/worker.test.ts:438-461`

### 现状

代码仍然是：

```ts
const taskPromise = this.processClaimedItem(item);
this.activeTaskPromises.add(taskPromise);
void taskPromise.finally(() => {
  this.activeTaskPromises.delete(taskPromise);
});
```

`Promise.prototype.finally()` 返回一个新的 Promise。若
`processClaimedItem()` reject，这个派生 Promise 也会 reject；当前代码使用
`void` 丢弃它，没有 rejection handler。

### 触发条件

`processClaimedItem()` 会捕获普通 publisher/token 错误，但以下异常仍能逃出：

- `markPublishOutboxSuccess()` 抛出数据库 I/O 错误；
- 进入外层 catch 后，`markPublishOutboxRetry()` 再次抛错；
- `markPublishOutboxFailed()` 抛错；
- 自定义 Store 适配器同步抛错。

在启用严格 unhandled-rejection 策略时，这可能终止 API 进程。当前 shutdown 测试
只覆盖 sleep wake 和重复 start/stop，没有制造 Store mutation rejection。

### 确定修复

给 `PublishWorkerDependencies` 增加不会抛出的错误出口：

```ts
onError?: (error: unknown, item: PublishOutboxItem) => void;
```

替换任务追踪代码：

```ts
const taskPromise = this.processClaimedItem(item);
this.activeTaskPromises.add(taskPromise);

void taskPromise.then(
  () => {
    this.activeTaskPromises.delete(taskPromise);
  },
  error => {
    this.activeTaskPromises.delete(taskPromise);
    try {
      this.onError(error, item);
    } catch {
      // Error reporting must never create a second rejected task.
    }
  }
);
```

`server.ts` 注入使用共享脱敏后的 logger。

增加测试 Store：

- `markPublishOutboxSuccess()` 抛错；
- `markPublishOutboxRetry()` 也抛错；
- 监听 `process.on("unhandledRejection")`；
- 断言 `onError` 恰好调用一次；
- 断言无 `unhandledRejection`；
- 断言 `stop()` 仍完成且 `activeClaims === 0`。

---

## P0-2：WAL 并发测试复制 SQL，没有测试生产 SQLiteJobStore

### 位置

- `apps/api/src/publish/walConcurrency.test.ts:43-89`
- 生产实现：`apps/api/src/jobs/sqliteJobStore.ts:206-276`

### 现状

worker thread 内重新写了一份 `UPDATE publish_outbox ... RETURNING`。它没有导入或
调用生产 `SQLiteJobStore.claimPublishOutboxItem()`，并且遗漏了生产事务中的：

- distinct `job_id` 提取；
- `jobs.awaiting_publish -> publishing` 更新；
- claimed job 最终状态验证；
- `publishOutboxItemSchema.parse()`。

因此生产 Store 即使删除 job 更新或状态验证，该测试仍会通过。

测试名还声称使用 barrier，但代码只是同时构造两个 Worker，没有 ready/start
barrier。线程启动时间由调度器决定，无法保证在同一竞争窗口开始 claim。

此外，测试只断言总领取数为 1，没有断言最终：

- job 为 `publishing`；
- outbox owner 属于获胜 Worker；
- `lease_generation === 1`。

### 确定修复

创建真实 worker fixture，例如：

`apps/api/src/publish/fixtures/walClaimWorker.ts`

使用 `tsx` loader 启动，使其直接导入：

```ts
import { openDatabase } from "../../db/connection";
import { SQLiteJobStore } from "../../jobs/sqliteJobStore";
```

每个线程：

1. 打开同一个文件型数据库；
2. 构造生产 `SQLiteJobStore`；
3. 通过 `SharedArrayBuffer + Atomics` 报告 ready；
4. 等待主线程同时释放 barrier；
5. 调用生产 `claimPublishOutboxItem(workerId, 30_000, 1)`；
6. 返回真实 Store 的领取结果。

主线程断言：

```ts
expect(totalClaimed).toBe(1);
expect(errors).toEqual([]);
expect(outbox.status).toBe("leased");
expect(outbox.leaseGeneration).toBe(1);
expect(["worker-A", "worker-B"]).toContain(outbox.leaseOwner);
expect(job.status).toBe("publishing");
```

禁止在测试 fixture 中复制 claim SQL。

---

## P0-3：崩溃窗口测试只测了 marker 查找，没有崩溃恢复链路

### 位置

- `apps/api/src/publish/worker.test.ts:376-410`

### 现状

当前测试只调用一次 `publishToGitHub()`，fake `paginate()` 立即返回包含 marker 的
两条评论，然后断言调用了 update。

它没有执行计划要求的：

1. 第一次 marker 不存在；
2. 生产 `createComment()` 成功并返回 999；
3. 在 `markPublishOutboxSuccess()` 前崩溃；
4. outbox 保持 `leased`；
5. lease 到期；
6. Worker B 领取并增加 generation；
7. 第二次生产 `publishToGitHub()` 分页找到 marker；
8. 保存 `external_id = "999"`；
9. GitHub 总共只创建一条评论。

所谓“page 2”也只有 2 条评论，未构造超过单页容量的数据。

### 确定修复

使用文件型 SQLite Store 完成完整测试：

```text
claim A
 -> publishToGitHub(no marker)
 -> createComment id=999
 -> intentionally skip markPublishOutboxSuccess
 -> force lease expiry
 -> claim B, generation=2
 -> publishToGitHub(marker at item 101/page 2)
 -> updateComment id=999
 -> markPublishOutboxSuccess(B, generation=2, externalId=999)
```

最终断言：

- `createComment` 总计 1 次；
- `updateComment` 总计 1 次；
- job 为 `succeeded`；
- outbox 为 `published`；
- `externalId === "999"`；
- stale Worker A 的 CAS 返回 false。

另加独立测试：

- 有效 externalId 直接 update；
- externalId update 返回 404 后 marker fallback。

---

## P1-1：统一凭据脱敏没有对应发布链路测试

### 位置

- 实现：`apps/api/src/security/redact.ts:27-32`
- 调用：`apps/api/src/publish/worker.ts:245`
- 现有测试：`apps/api/src/security/redact.test.ts`

### 现状

`sanitizePublishFailure()` 已实现并被 Worker 调用，但没有任何测试调用该函数，也
没有测试三个持久化字段：

- `publish_outbox.last_error`；
- `jobs.error`；
- `reports.github_comment_error`。

`worker.test.ts` 中出现的 `ghs_fake` 仅作为成功发布 token，不是错误脱敏测试。
Walkthrough 声称已验证该门禁，与实际测试不符。

### 确定修复

增加 SQLite 集成测试，分别让 tokenFetcher 和 publisher 抛出包含以下内容的错误：

```text
ghs_...
github_pat_...
Authorization: Bearer ...
当前确切 token 值
PEM private key
```

执行失败/重试后查询三个表，断言所有原始秘密均不存在，且错误长度不超过
500 字符。

`classifyGitHubError()` 应复用 `sanitizePublicError()`，删除
`githubPublisher.ts:29-34` 的重复、不完整私有正则。

---

## P1-2：0003 回滚测试没有执行真实 migration

### 位置

- `apps/api/src/publish/worker.test.ts:56-77`
- 真实 migration：`apps/api/src/db/migrations.ts` 的
  `0003_publish_outbox_leasing`

### 现状

测试创建了一个新的 `id: "0003_faulty"` migration，只执行第一条
`ALTER TABLE ... lease_generation` 后抛错。

它没有调用真实 `migrations[2].up(db)`，因此不会覆盖：

- 第二个 `external_id` ALTER；
- 真实 0003 后续发生失败时两个 DDL 的整体回滚；
- `schema_migrations` 中真实 0003 ID 未被记录。

### 确定修复

```ts
const real0003WithFailure: Migration = {
  id: migrations[2]!.id,
  up(db) {
    migrations[2]!.up(db);
    throw new Error("Failure after real 0003");
  }
};
```

在只应用 0001、0002 后执行它，并断言：

- `lease_generation` 不存在；
- `external_id` 不存在；
- `schema_migrations` 不包含 `0003_publish_outbox_leasing`；
- 0002 历史 outbox 行仍完整存在。

---

## P1-3：CI 清理后仍保留旧 Python lint 路径和多余写权限

### 位置

- `.github/workflows/ci.yml:7-9`
- `.github/workflows/ci.yml:34-36`

### 问题

CI 已删除 V1 CLI 步骤，但 Ruff 仍执行：

```yaml
ruff check backend tests
```

V2 生产 Python 引擎位于 `engine/`，因此当前 CI 不 lint 核心 engine 代码。

同时旧评论步骤删除后，workflow 仍声明：

```yaml
pull-requests: write
```

现有步骤不再需要 PR 写权限。

### 确定修复

```diff
 permissions:
   contents: read
-  pull-requests: write

@@
-ruff check backend tests
+ruff check engine tests
```

如果 Phase 6 后 `backend/` 仍保留合法生产文件，再明确加入；不得用 `backend`
替代 `engine`。

---

## P2：验收文档提前宣告 Approved，测试统计错误

### 位置

- `task.md:7`
- `walkthrough.md:5`
- `walkthrough.md:40`

### 问题

- 未经终验已把 Phase 5 标记为 `Approved`；
- Walkthrough 声称全部要求已验证；
- 写成“120/120、27 files”，但这是 API workspace 的数字；
- 括号中又写“25 API、2 Web、2 Schema”，内部总数为 29，也与实际不符。

### 确定修复

Redo 期间恢复：

```md
- [ ] Phase 5: Publish Outbox & Retry (Redo Under Review)
```

最终测试统计应写：

```text
API: 27 files / 120 tests
Web: 2 files / 6 tests
Schema: 2 files / 15 tests
Total: 31 files / 141 tests
```

只有审计批准后才能把状态改成 Approved。

---

## Redo 完成门禁

- 修复任务 Promise rejection handler；
- WAL 测试必须调用生产 Store 并使用真实 barrier；
- 完成真实 create/crash/lease takeover/marker recovery 测试；
- 补齐三表错误脱敏集成测试；
- 0003 回滚测试调用真实 migration；
- CI lint `engine` 并移除 PR 写权限；
- 修正文档状态和 141 项总统计；
- `npm run typecheck`、`npm test`、`npm run build`、
  `python -m pytest -q`、`git diff --check` 全部通过；
- Phase 7 再在 Node 22.x + Python 3.12.x 下执行正式基线。
