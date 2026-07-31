# ConsistenCy V2 Phase 5 最终门禁 Redo 审计报告

## 结论

**Phase 5 暂缓最终批准，仅剩 1 项 P1 测试生命周期门禁。**

上一轮要求的生产路径与验收覆盖已经基本完成：

- WAL 屏障已移动到 `openDatabase()` 与 `SQLiteJobStore` 构造之后；
- 有效 `externalId` 快速路径已独立验证；
- tokenFetcher 永久失败与 publisher transient retry 的持久化脱敏均已覆盖；
- 147 项 TypeScript 测试、115 项 Python 测试、类型检查和生产构建全部通过。

本轮未发现新的生产代码缺陷。请只修复下述测试资源清理问题，不要再次调整 Phase 5 架构。

---

## P1：WAL ready 超时没有终止阻塞的 Worker

- **文件**：`apps/api/src/publish/walConcurrency.test.ts`
- **位置**：第 48–80 行
- **关联 fixture**：`apps/api/src/publish/fixtures/walClaimWorker.ts` 第 17–18 行

### 问题

当前超时分支为：

```ts
if (Date.now() >= readyDeadline) {
  throw new Error("Timed out waiting for both WAL claim workers to open their database connections");
}
```

`Worker` 实例只存在于 `runThread()` 的局部作用域，超时分支无法访问并终止它们。

边界条件如下：

1. Worker A 成功打开数据库，发出 ready，然后阻塞在 `Atomics.wait(...)`；
2. Worker B 在发出 ready 前启动失败；
3. 主线程等待 5 秒后抛出异常；
4. start barrier 从未释放，Worker A 继续永久阻塞；
5. 测试也跳过末尾数据库文件清理。

因此“5 秒超时”只保证主测试 Promise 被拒绝，不能保证测试进程和资源在 5 秒内退出。上一轮门禁明确要求超时时终止两个 Worker，当前实现尚未满足。

### 确定修复

在测试作用域保存 Worker 引用，并在超时前终止全部线程：

```diff
 const workerFixture = resolve(__dirname, "./fixtures/walClaimWorker.ts");
+const workers: Worker[] = [];

 const runThread = (...) => {
   return new Promise((res, rej) => {
     const worker = new Worker(workerFixture, {
       execArgv: ["--import", "tsx"],
       workerData: { dbPath, workerId, sharedBuffer }
     });
+    workers.push(worker);
     // existing listeners
   });
 };
```

将 ready 等待包装为可清理的控制流：

```ts
try {
  const readyDeadline = Date.now() + 5_000;
  while (Atomics.load(typedArray, 0) < 2) {
    if (Date.now() >= readyDeadline) {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
      throw new Error(
        "Timed out waiting for both WAL claim workers to open their database connections"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  Atomics.store(typedArray, 1, 1);
  Atomics.notify(typedArray, 1, 2);

  // existing assertions
} finally {
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
  // close any opened verification DB before this point
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${dbPath}${suffix}`;
    if (existsSync(target)) unlinkSync(target);
  }
}
```

也可让 `runThread()` 返回 `{ worker, result }`，但必须满足同一语义：超时和断言失败路径都能访问、终止并等待所有 Worker。

### 必须增加的确定性失败测试

不能只依赖代码审阅。为屏障等待提取可注入/可测试的 helper，或为 fixture 增加一个仅测试使用的 `failBeforeReady` 参数，验证：

- Worker A 已 ready 并阻塞；
- Worker B 在 ready 前失败；
- 主测试在 5 秒以内拒绝；
- 两个 Worker 均已退出；
- 临时 `.db`、`.db-wal`、`.db-shm` 文件被清理；
- Vitest 进程不会遗留线程或挂起。

---

## 独立验证结果

- `npm run typecheck`：通过。
- `npm test`：API 126、Web 6、Schema 15，共 **147/147** 通过。
- `npm run build`：通过。
- `python -m pytest -q`：**115/115** 通过。
- `git diff --check`：退出码 0；仅有 Git 的 LF/CRLF 转换提示，无 whitespace error。

## 最终批准条件

修复 WAL 超时/异常路径的 Worker 终止与临时文件清理，并增加确定性失败测试后，即可批准 Phase 5。无需再次修改生产代码或增加新的 Phase 5 功能。
