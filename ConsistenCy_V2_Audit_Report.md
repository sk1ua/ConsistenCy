# ConsistenCy V2 审计报告

## 1. 终验结论

**结论：BLOCK。不得创建 `v2` 分支，不得提交或推送。**

最新 Redo 在普通 Node 25 环境中显示通过，但在项目锁定的联合基线中仍失败：

```text
Node v22.23.2
Python 3.12.12
```

本轮通过：

- `npm ci`：PASS，0 vulnerabilities
- `npm run verify:runtime`：PASS
- `npm run audit:deps`：PASS，0 vulnerabilities
- Python demo / ablation CLI：PASS
- Ruff：PASS
- Pytest：116 passed
- `npm run typecheck`：PASS

本轮阻断：

```text
npm test
API: 28 files, 27 passed, 1 failed
API: 131 tests, 129 passed, 2 failed
Web: 6 passed
Schema: 14 passed
```

失败均来自 `apps/api/src/publish/walConcurrency.test.ts`。按终验规则，本轮在首个代码阻断处停止，未继续运行生产 build、两轮 Playwright E2E，也未执行任何 Git 分支、提交或推送。

## 2. P0-1：Node 22 Worker 中的 `tsx` 注册方式仍然错误

### 位置

- `apps/api/src/publish/fixtures/walClaimWorker.ts:2-3`
- `apps/api/src/publish/walConcurrency.test.ts:76-86`
- `apps/api/src/publish/walConcurrency.test.ts:168-178`
- `apps/api/src/publish/walConcurrency.test.ts:219-229`

### 当前代码

```ts
// walClaimWorker.ts
import { openDatabase } from "../../db/connection.js";
import { SQLiteJobStore } from "../../jobs/sqliteJobStore.js";
```

```ts
new Worker(workerFixture, {
  execArgv: ["--import", "tsx"],
  workerData: { /* ... */ }
});
```

### 固定基线中的真实错误

```text
Cannot find module
'D:\sk1ua\python\ConsistenCy\apps\api\src\db\connection.js'
imported from
'D:\sk1ua\python\ConsistenCy\apps\api\src\publish\fixtures\walClaimWorker.ts'
```

`--import tsx` 作为 `Worker.execArgv` 使用时，并没有在该 Worker 主执行上下文中注册完整的 ESM resolve hook。Node 22 能进入 `.ts` fixture，但相对 `.js` specifier 仍由 Node 原生解析，因此它只查找物理的 `connection.js`，不会回退到 `connection.ts`。

以下替代也已在 Node 22.23.2 中实测无效，禁止再次采用：

- 把 `execArgv` 改为 `tsx/esm`：Worker 仍报同一个 `connection.js` 不存在；
- 把 import 改为显式 `.ts`：依赖中的 TypeScript parameter property 被 Node 原生 strip-only 模式拒绝；
- 加 `--no-experimental-strip-types`：Worker 变为 `Unknown file extension ".ts"`。

### 确定修复

使用普通 `.mjs` 作为 Worker bootstrap，在 Worker 主上下文中通过 `tsx/esm/api` 显式注册 loader，然后再加载 TypeScript fixture。

新增文件：`apps/api/src/publish/fixtures/walClaimWorkerBootstrap.mjs`

```js
import { register } from "tsx/esm/api";

register();
await import("./walClaimWorker.ts");
```

保留 `walClaimWorker.ts` 当前的标准 `.js` specifier，不要改成 `.ts`。

将 `walConcurrency.test.ts` 中三处 Worker 入口统一改为 bootstrap，并禁止继承无关的 execArgv：

```diff
-const workerFixture = resolve(__dirname, "./fixtures/walClaimWorker.ts");
+const workerFixture = resolve(__dirname, "./fixtures/walClaimWorkerBootstrap.mjs");

 const worker = new Worker(workerFixture, {
-  execArgv: ["--import", "tsx"],
+  execArgv: [],
   workerData
 });
```

该 bootstrap 方案已在 Node v22.23.2 的真实 `worker_threads.Worker` 中验证：依赖加载成功并到达 fixture 的预期业务异常 `Simulated worker failure before ready`，不再出现模块解析或 strip-only 错误。

## 3. P0-2：timeout 测试仍会吞掉 Worker bootstrap 错误并假绿

### 位置

- `apps/api/src/publish/walConcurrency.test.ts:238-249`

### 当前代码

```ts
const threadA = runThread("worker-A");
const threadB = runThread("worker-B", { blockBeforeReady: true });

threadA.catch(() => {});
threadB.catch(() => {});

await expect(
  waitForWorkersReady(typedArray, 2, 100, workers)
).rejects.toThrow(
  "Timed out waiting for both WAL claim workers to open their database connections"
);
```

### 为什么是问题

当前 Node 22 下两个 Worker 都因 `ERR_MODULE_NOT_FOUND` 崩溃，但这两个 rejection 被空 `catch` 吞掉。ready 计数保持 0，100ms 后 `waitForWorkersReady` 恰好抛出测试所期望的 timeout，因此第三个测试通过。

也就是说，测试名称宣称验证“一个正常 Worker ready + 一个存活但不 ready”，实际在当前失败运行中两个 Worker 都没有成功启动。该测试不能区分真实超时和双 Worker bootstrap 崩溃。

### 确定修复

删除两个空 `catch`，对两个结果 Promise 构造立即生效的失败竞争；先证明至少一个正常 Worker 已 ready，再验证第二个 Worker 保持存活但不 ready：

```ts
const threads = [
  runThread("worker-A"),
  runThread("worker-B", { blockBeforeReady: true })
];

const firstWorkerFailure = Promise.race(
  threads.map((thread) =>
    thread.then(
      () => new Promise<never>(() => {}),
      (error) => Promise.reject(error)
    )
  )
);

// 必须先证明正常 Worker 完成数据库与 Store 初始化。
await Promise.race([
  waitForWorkersReady(typedArray, 1, 5_000, workers),
  firstWorkerFailure
]);

// 只有第二个 Worker 活着但永远不 ready 时，这一步才允许命中 timeout。
await expect(
  Promise.race([
    waitForWorkersReady(typedArray, 2, 100, workers),
    firstWorkerFailure
  ])
).rejects.toThrow(
  "Timed out waiting for both WAL claim workers to open their database connections"
);
```

继续保留 `finally` 中的 `terminateWorkers(workers)` 以及 `.db` / `-wal` / `-shm` 删除断言。

## 4. P1：消除三份 `runThread` 复制，防止门禁行为再次漂移

### 位置

- `apps/api/src/publish/walConcurrency.test.ts:79-97`
- `apps/api/src/publish/walConcurrency.test.ts:171-184`
- `apps/api/src/publish/walConcurrency.test.ts:222-235`

三个局部实现的事件监听和退出语义不一致：第一份监听 `exit`，后两份不监听；第一份 message 后主动 terminate，后两份直接 resolve。此次 timeout 假绿正是这种重复造成的门禁漂移。

### 确定修复

提取单一 `spawnWalClaimWorker()` helper，统一：

- bootstrap `.mjs` 入口；
- `message` / `error` / `exit` 监听；
- Promise 单次 settlement；
- Worker 注册到共享 `workers` 数组；
- 所有测试使用相同的错误传播规则。

至少增加断言：

```ts
expect(Atomics.load(typedArray, 0)).toBe(1);
```

该断言应位于 timeout 阶段开始前，明确证明只有一个 Worker ready。

## 5. 修复后的唯一复验顺序

必须在同一个 Node 22.x + Python 3.12.x shell 中从锁文件重装依赖后执行：

```powershell
node -v
python --version
npm ci
npm run verify:runtime
npm run audit:deps
python examples/multi_agent_demo.py
python evaluation/scripts/run_ablation.py --help
python -m ruff check engine tests evaluation/scripts examples
python -m pytest -q
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:e2e
git diff --check
```

额外验收：

- WAL 三个场景必须在 Node 22 下全部通过；
- bootstrap error 必须立即显示原始错误，不能退化成 timeout；
- timeout 场景开始前 ready count 必须等于 1；
- Vitest 不得报告 unhandled rejection；
- 两轮 E2E 不得产生外部 GitHub 请求、Worker error 或残留 `consistency-e2e-*` 临时目录。

全部通过前，Phase 7 保持 `REDO IN PROGRESS`。
