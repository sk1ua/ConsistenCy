# ConsistenCy V2 Phase 5 最终门禁审计报告

## 结论

**暂不批准 Phase 5 终验。**

本轮未发现新的生产代码 P0 缺陷；此前的 Promise rejection 出口、迁移回滚、CI 权限与 Ruff 范围、崩溃窗口恢复等核心修复均已落地。独立执行的 144 项 TypeScript 测试和生产构建也全部通过。

但仍有 3 个 **P1 验收证据缺口**。它们不会直接证明生产实现错误，却意味着既定 Phase 5 门禁尚未被测试严格证明。请只修复以下测试，不要再扩展架构或重写生产路径。

---

## P1-1：WAL 并发屏障在数据库连接建立前放行

- **文件**：`apps/api/src/publish/fixtures/walClaimWorker.ts`
- **位置**：第 8–16 行
- **关联测试**：`apps/api/src/publish/walConcurrency.test.ts` 第 67–74 行

### 问题

Worker 当前先执行：

```ts
Atomics.add(typedArray, 0, 1);
Atomics.wait(typedArray, 1, 0);
```

随后才执行：

```ts
const database = openDatabase(dbPath);
const store = new SQLiteJobStore(database);
```

因此主线程观察到 `ready count === 2` 时，只能证明两个线程已启动，不能证明两个独立 SQLite 连接已经打开并准备争抢同一 outbox 行。屏障释放后，连接初始化可能自然串行化，测试仍会通过，但没有覆盖预期的双连接并发 claim 竞争。

此外，主线程的 ready 等待循环没有超时；若任一 Worker 在发出 ready 前失败，测试会永久等待。

### 确定修复

将数据库连接和 Store 构造移动到 ready 信号之前：

```diff
 const { dbPath, workerId, sharedBuffer } = workerData;
 const typedArray = new Int32Array(sharedBuffer);

-Atomics.add(typedArray, 0, 1);
-Atomics.wait(typedArray, 1, 0);
-
 const database = openDatabase(dbPath);
 database.pragma("busy_timeout = 5000");
 const store = new SQLiteJobStore(database);
+
+// “ready” 必须表示独立数据库连接和生产 Store 均已就绪。
+Atomics.add(typedArray, 0, 1);
+Atomics.notify(typedArray, 0);
+Atomics.wait(typedArray, 1, 0);
```

同时给主线程屏障增加明确超时，并在超时时终止两个 Worker：

```ts
const readyDeadline = Date.now() + 5_000;
while (Atomics.load(typedArray, 0) < 2) {
  if (Date.now() >= readyDeadline) {
    throw new Error("Timed out waiting for both WAL claim workers to open their database connections");
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
```

### 验收

- 屏障释放前，两个 Worker 均已完成 `openDatabase()` 和 `new SQLiteJobStore()`。
- 两个独立连接同时调用生产 `claimPublishOutboxItem()`。
- 总 claim 数严格为 1，无 `SQLITE_BUSY`，最终 `lease_generation === 1`。
- ready 失败在 5 秒内明确失败，不能无限挂起。

---

## P1-2：`externalId` 成功快速路径没有被测试

- **文件**：`apps/api/src/publish/worker.test.ts`
- **位置**：第 550–582 行
- **函数**：`publishToGitHub`

### 问题

测试名称声称覆盖 “Fast-path externalId update and 404 fallback”，但现有 fake client 对 `comment_id === 999` 必然抛出 404，实际只覆盖了：

1. 尝试 externalId；
2. externalId 返回 404；
3. 回退 marker 搜索；
4. 更新 marker 对应评论。

它没有证明 **externalId 有效时直接更新，并且完全不调用分页搜索和 createComment**。该路径是重试与崩溃恢复的第一优先级路径，必须单独锁定。

### 确定修复

保留现有 404 fallback 测试，并新增独立测试：

```ts
it("uses a valid externalId without marker pagination or comment creation", async () => {
  const paginate = vi.fn();
  const createComment = vi.fn();
  const updateComment = vi.fn(async ({ comment_id }: { comment_id: number }) => ({
    data: { id: comment_id }
  }));

  const result = await publishToGitHub(
    {
      report: createValidReport("job_external_id"),
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 42,
      token: "ghs_test_token",
      externalId: "999"
    },
    { createClient: () => ({ paginate, createComment, updateComment }) }
  );

  expect(result.commentId).toBe("999");
  expect(updateComment).toHaveBeenCalledTimes(1);
  expect(updateComment).toHaveBeenCalledWith(
    expect.objectContaining({ comment_id: 999 })
  );
  expect(paginate).not.toHaveBeenCalled();
  expect(createComment).not.toHaveBeenCalled();
});
```

### 验收

- 有效 `externalId` 只触发一次 `updateComment`。
- `paginate` 与 `createComment` 调用次数均为 0。
- 现有 404 fallback 测试继续保留并通过。

---

## P1-3：统一脱敏仅覆盖 publisher 永久失败

- **文件**：`apps/api/src/publish/worker.test.ts`
- **位置**：第 584–643 行
- **相关逻辑**：`PublishWorker.processItem`、`sanitizePublishFailure`

### 问题

当前 SQLite 落库断言只让 `publisher` 抛出 `PermanentPublishError`，因此只证明了永久失败路径写入以下字段时会脱敏：

- `publish_outbox.last_error`
- `jobs.error`
- `reports.github_comment_error`

既定门禁还要求分别验证：

1. `tokenFetcher` 抛出含凭据错误时的永久失败落库；
2. transient/rate-limit 错误进入 `retrying` 时，`publish_outbox.last_error` 和 `reports.github_comment_error` 仍然脱敏。

这两条路径的控制流和最终状态不同，不能由当前 publisher 永久失败测试替代。

### 确定修复

增加两个使用真实 `SQLiteJobStore` 的测试：

#### A. Token fetcher 失败

```ts
tokenFetcher: async () => {
  throw new PermanentPublishError(
    "token fetch failed: Bearer secret_bearer_token_val github_pat_SECRET_PAT_9876543210zyx",
    401
  );
},
publisher: vi.fn()
```

断言：

- `publisher` 未调用；
- outbox 为 `failed`，job 为 `publish_failed`，report comment status 为 `failed`；
- 三个错误字段均不包含原始 Bearer/PAT，且长度不超过 500。

#### B. Transient retry 失败

```ts
tokenFetcher: async () => "ghs_SECRET_TOKEN_1234567890abcdef",
publisher: async () => {
  throw new TransientPublishError(
    "network failed with Bearer secret_bearer_token_val"
  );
}
```

使用足够长的 poll interval 或在首次 attempt 完成后立即停止 Worker，断言：

- outbox 为 `retrying`，`attempt_count === 1`；
- job 回到 `awaiting_publish`；
- report comment status 仍为 `pending`；
- `publish_outbox.last_error` 与 `reports.github_comment_error` 均不含 token/Bearer，且长度不超过 500。

### 验收

- tokenFetcher 与 publisher 的异常分别被测试。
- permanent 与 transient 两类落库路径分别被测试。
- 所有对外持久化错误字段均无 PAT、installation token、Bearer 值或 PEM 内容。

---

## 已独立验证通过的项目

- `npm run typecheck`：通过。
- `npm test`：通过；API 123、Web 6、Schema 15，共 **144 项**。
- `npm run build`：通过；Web 生产构建成功。
- `python -m pytest -q`：通过；**115 项**。
- `git diff --check`：退出码 0。
- 当前执行环境：Node.js 25.8.1、Python 3.11.9；这不是 Phase 7 的正式基线环境。最终基线仍须在 Node.js 22.x 与 Python 3.12.x 执行。

## 下一轮审查边界

下一轮只验收上述 3 个测试门禁：

1. WAL 屏障必须位于数据库连接和 Store 构造之后，并具备超时；
2. 有效 `externalId` 成功快速路径有独立断言；
3. tokenFetcher 永久失败及 transient retry 的持久化脱敏有独立断言。

三项满足且现有测试无回归后，可批准 Phase 5；无需再次修改生产架构。
