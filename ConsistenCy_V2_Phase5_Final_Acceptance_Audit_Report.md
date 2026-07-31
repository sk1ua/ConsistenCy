# ConsistenCy V2 Phase 5 最终验收审计报告

## 结论

**生产实现验收通过；Phase 5 测试门禁尚差 1 个最小修正，暂不签署完全验收。**

本轮没有发现新的生产代码问题。Worker 引用、`finally` 终止和数据库文件清理均已实现，148 项 TypeScript 测试及 115 项 Python 测试全部通过。

剩余问题仅是：新增失败测试没有执行生产成功测试实际使用的 timeout 分支，而是复制了另一套控制流，因此无法防止真实 timeout 分支将来回归。

---

## P1：失败测试没有调用实际 timeout 控制流

- **文件**：`apps/api/src/publish/walConcurrency.test.ts`
- **真实 timeout 分支**：第 76–83 行
- **新增失败测试**：第 158–170 行

### 问题

成功测试使用的 timeout 分支会：

```ts
await Promise.allSettled(workers.map(w => w.terminate()));
throw new Error("Timed out waiting for both WAL claim workers to open their database connections");
```

但新增失败测试没有执行该分支，而是重新实现了另一套循环：

```ts
let timedOut = false;
while (Atomics.load(typedArray, 0) < 2) {
  if (Date.now() >= readyDeadline) {
    timedOut = true;
    break;
  }
}
expect(timedOut).toBe(true);
```

这只证明测试自己的 `finally` 可以清理 Worker，不能证明第 76–80 行会：

- 以正确错误拒绝；
- 在拒绝前终止 Worker；
- 与 `finally` 清理安全协作。

此外，失败测试要求 Worker A 在固定 **500ms** 内完成 TSX loader、打开 SQLite 并发出 ready：

```ts
expect(Atomics.load(typedArray, 0)).toBe(1);
```

在高负载 CI 上，Worker A 可能尚未 ready，导致与产品行为无关的假失败。

### 确定修复

提取两项共享 helper，并让成功测试与失败测试调用同一实现：

```ts
async function terminateWorkers(workers: Worker[]): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
}

async function waitForWorkersReady(
  state: Int32Array,
  expectedReady: number,
  timeoutMs: number,
  workers: Worker[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(state, 0) < expectedReady) {
    if (Date.now() >= deadline) {
      await terminateWorkers(workers);
      throw new Error(
        "Timed out waiting for both WAL claim workers to open their database connections"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

成功测试替换为：

```ts
await waitForWorkersReady(typedArray, 2, 5_000, workers);
```

失败测试应先给正常 Worker 最多 5 秒完成 ready，避免固定 500ms 启动假设，然后测试共享 timeout helper：

```ts
const workerAReadyDeadline = Date.now() + 5_000;
while (Atomics.load(typedArray, 0) < 1) {
  if (Date.now() >= workerAReadyDeadline) {
    throw new Error("Normal WAL worker did not become ready");
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

await expect(
  waitForWorkersReady(typedArray, 2, 100, workers)
).rejects.toThrow(
  "Timed out waiting for both WAL claim workers to open their database connections"
);
```

`finally` 中继续调用同一个 `terminateWorkers(workers)` 并清理 `.db`、`-wal`、`-shm`。

### 验收断言

- 成功与失败测试调用相同的 `waitForWorkersReady()`。
- 失败测试使用 `.rejects.toThrow(...)` 验证真实错误。
- Worker A 的启动等待上限为 5 秒，不依赖其必须在 500ms 内启动。
- timeout Promise 返回时所有 Worker 已完成 `terminate()`。
- `finally` 后三个 SQLite 临时文件均不存在。

---

## 已独立通过

- `npm run typecheck`：通过。
- `npm test`：API 127、Web 6、Schema 15，共 **148/148**。
- `npm run build`：通过。
- `python -m pytest -q`：**115/115**。
- `git diff --check`：退出码 0；仅有 LF/CRLF 转换提示。

完成上述共享 helper 与真实 rejection 测试后，可直接批准 Phase 5；无需再次修改任何生产代码。
