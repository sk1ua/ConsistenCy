# ConsistenCy V2 Phase 7 固定基线终验报告

## 1. 结论

**结论：BLOCK。Node 22.x + Python 3.12.x 固定基线终验失败。**

本轮首次在同一个联合环境中实际运行完整门禁：

```text
Node v22.23.2
Python 3.12.12
```

以下项目通过：

- `npm ci`
- `npm audit --audit-level=high`：0 vulnerabilities
- `npm run verify:runtime`
- `python examples/multi_agent_demo.py`
- `python evaluation/scripts/run_ablation.py --help`
- `ruff check engine tests evaluation/scripts examples`
- `python -m pytest -q`：116 passed
- `npm run typecheck`

但 `npm test` 在 API workspace 的 WAL worker_threads 测试中失败：

```text
src/publish/walConcurrency.test.ts
2 tests | 2 failed

Error [ERR_MODULE_NOT_FOUND]:
Cannot find module
'.../apps/api/src/db/connection'
imported from
'.../apps/api/src/publish/fixtures/walClaimWorker.ts'
```

测试随后表现为两个 5 秒超时，并产生两个 Vitest unhandled rejection。

根据终验规则，本轮在首个阻断项处停止。没有继续执行：

- runtime-gate root test；
-生产 build；
- 固定基线 Playwright E2E；
- Git 分支、提交或推送。

## 2. P0 阻断：Node 22 ESM Worker 无法解析 fixture 的无扩展名导入

### 位置

- `apps/api/src/publish/fixtures/walClaimWorker.ts:2`
- `apps/api/src/publish/fixtures/walClaimWorker.ts:3`
- `apps/api/src/publish/walConcurrency.test.ts:74-82`
- `apps/api/src/publish/walConcurrency.test.ts:150-158`

### 当前代码

```ts
import { openDatabase } from "../../db/connection";
import { SQLiteJobStore } from "../../jobs/sqliteJobStore";
```

Worker 使用：

```ts
new Worker(workerFixture, {
  execArgv: ["--import", "tsx"]
});
```

### 为什么只在固定基线失败

主 Vitest 进程会经过 Vite/Vitest 的 TypeScript 模块解析，因此普通测试中的无扩展名导入可以工作。

`worker_threads.Worker` 是独立的 Node ESM 执行环境。Node 22 使用 `--import tsx` 加载 `.ts` fixture 时，不会为上述相对 ESM specifier 自动补 `.ts`，最终尝试加载：

```text
apps/api/src/db/connection
```

并抛出 `ERR_MODULE_NOT_FOUND`。

之前 Node 25 下的通过结果不能证明 Node 22 兼容，这正是固定基线门禁必须存在的原因。

### 确定修复

将 fixture 的运行时相对导入改为标准 ESM `.js` specifier：

```diff
-import { openDatabase } from "../../db/connection";
-import { SQLiteJobStore } from "../../jobs/sqliteJobStore";
+import { openDatabase } from "../../db/connection.js";
+import { SQLiteJobStore } from "../../jobs/sqliteJobStore.js";
```

不要写 `.ts`：

- `.js` 是 TypeScript ESM/NodeNext 的标准源代码 specifier；
- `tsx` 会在开发/测试时将 `.js` specifier 映射到对应 `.ts` 源文件；
- TypeScript `moduleResolution: "Bundler"` 可以正确解析；
- 不需要开启 `allowImportingTsExtensions`。

本轮已使用 Node 22 做只读解析验证：

```text
node --import tsx --input-type=module \
  -e "import('./apps/api/src/db/connection.js')..."

function
```

该结果证明 `.js` specifier 能在目标运行时解析到 `connection.ts`。

### 禁止的伪修复

不得：

- 仅把测试超时从 5 秒调大；
- 在 Node 22 下跳过 WAL 测试；
- 根据 Node 版本条件跳过 Worker；
- 把 `engines.node` 再次放宽；
- 吞掉 `ERR_MODULE_NOT_FOUND`；
- 将多线程 WAL 测试改回单线程 mock。

## 3. P1：Worker 启动错误被掩盖成超时和 unhandled rejection

### 位置

- `apps/api/src/publish/walConcurrency.test.ts:13-29`
- `apps/api/src/publish/walConcurrency.test.ts:77-103`
- `apps/api/src/publish/walConcurrency.test.ts:153-186`
- `apps/api/src/publish/fixtures/walClaimWorker.ts:8-10`

### 当前行为

`runThread()` 返回的 Promise 在 Worker `error` 时 reject，但第一个并发测试在等待：

```ts
await waitForWorkersReady(...)
```

期间没有给 `thread1` / `thread2` 安装立即生效的 rejection handler。

因此 Worker 模块加载失败时：

1. 两个结果 Promise reject；
2. ready counter 永远不增加；
3. 主测试继续轮询 5 秒；
4. 最终只报告 ready timeout；
5. Vitest 另外报告 unhandled rejection。

真实根因被超时噪声掩盖。

第二个测试用 `failBeforeReady: true` 主动抛异常，却吞掉 Promise rejection 后等待 ready timeout。它把“Worker 崩溃”和“Worker 活着但未 ready”混成了同一种场景。

### 确定修复

#### A. 正常并发测试必须在 Worker bootstrap error 时立即失败

创建结果 Promise 后立即安装错误竞争：

```ts
const threads = [
  runThread("worker-A"),
  runThread("worker-B")
];

const firstWorkerFailure = Promise.race(
  threads.map(thread =>
    thread.then(
      () => new Promise<never>(() => {}),
      error => Promise.reject(error)
    )
  )
);

await Promise.race([
  waitForWorkersReady(typedArray, 2, 5_000, workers),
  firstWorkerFailure
]);

Atomics.store(typedArray, 1, 1);
Atomics.notify(typedArray, 1, 2);

const results = await Promise.all(threads);
```

验收断言：

- fixture import 写错时，测试应在明显小于 5 秒内直接报告 `ERR_MODULE_NOT_FOUND`；
- 不得出现 Vitest unhandled rejection；
- 正常路径仍断言只有一个 outbox 被领取。

#### B. timeout 测试必须模拟“阻塞但不崩溃”

fixture 增加独立模式，例如：

```ts
const { blockBeforeReady } = workerData;

if (blockBeforeReady) {
  Atomics.wait(typedArray, 1, 0);
}
```

timeout 测试使用：

```ts
runThread("worker-B", { blockBeforeReady: true });
```

不要用主动 `throw` 模拟 timeout。主动抛错应另写 fail-fast 测试，断言错误立即传播。

### 建议新增测试

至少形成三个独立场景：

1. 两个正常 Worker 同时 claim，恰好一个成功；
2. 一个 Worker 在 ready 前发生 bootstrap error，测试立即失败且无 unhandled rejection；
3. 一个 Worker 保持存活但永远不 ready，`waitForWorkersReady` 超时、终止全部 Worker 并清理 DB/WAL/SHM。

## 4. 固定基线实测明细

### 通过

```text
Node:                  v22.23.2
Python:                3.12.12
npm ci:                PASS
npm audit:             PASS, 0 vulnerabilities
verify:runtime:         PASS
Python demo:           PASS
Ablation CLI --help:   PASS
Ruff:                  PASS
Pytest:                PASS, 116 tests
TypeScript typecheck:  PASS
```

### 失败

```text
API Vitest:
  28 files discovered
  27 passed
  1 failed

  130 tests:
  128 passed
  2 failed

Failure:
  walConcurrency.test.ts
  ERR_MODULE_NOT_FOUND from walClaimWorker.ts
```

Web workspace 的 6 项测试和 schema workspace 的 14 项测试随后各自通过，但根 `npm test` 总体退出码为 1。

## 5. 修复后的唯一复验顺序

必须继续使用同一个 Node 22.x + Python 3.12.x shell：

```powershell
node -v
python --version
npm run verify:runtime
npm ci
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

- WAL 三个独立场景全部通过；
- 无 unhandled rejection；
- 两轮 E2E 无外部请求、无 Worker error、无临时目录残留；
- 所有命令退出码均为 0。

全部通过前：

- Phase 7 保持 `REDO IN PROGRESS`；
- 不得创建 `v2`；
- 不得 commit；
- 不得 push。
