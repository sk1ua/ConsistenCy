# ConsistenCy V2 Phase 7 Redo 3 验收审计报告

## 1. 结论

**结论：CONDITIONAL BLOCK。核心 P0 已修复，但 Phase 7 尚不能批准。**

本轮独立执行两次 Playwright E2E：

```text
run_1_exit=0
run_1_forbidden_log_count=0
run_1_temp_leftovers=0

run_2_exit=0
run_2_forbidden_log_count=0
run_2_temp_leftovers=0
```

上一轮真实 GitHub installation token 请求已经消失；ReviewWorker/PublishWorker 确实未启动；两轮均使用独立临时状态并完成清理。服务端隔离主问题通过。

但仍有三类验收缺口：

1. 新增的配置加载分支没有单元测试，并且 `loadRuntimeConfig()` 的 `environment` 注入与 SettingsStore 根目录解析不一致；
2. 运行时门禁测试删除了“Python 命令不存在”的进程/执行器场景；
3. 状态徽标和风险级别仍只验证元素或标签存在，没有验证实际翻译/风险值；
4. 最终完整序列仍未在 Node 22.x + Python 3.12.x 中执行。

因此 `task.md` 应继续保持 `[/]`，`implementation_plan.md` 应继续保持 `REDO IN PROGRESS`。

## 2. 已通过项目

### 2.1 服务端配置与凭据隔离

以下实现已验证有效：

- `apps/api/src/config/env.ts:19-22`
- `apps/api/src/config/runtime.ts:21-28`
- `apps/api/src/server.ts:172-176`
- `playwright.config.ts:35-51`

E2E API 使用：

```text
CONSISTENCY_SETTINGS_ROOT=<temporary root>
CONSISTENCY_LOAD_ENV_FILE=false
CONSISTENCY_WORKERS_ENABLED=false
GITHUB_APP_ID=""
GITHUB_PRIVATE_KEY=""
DEEPSEEK_API_KEY=""
OPENAI_API_KEY=""
```

两轮日志均未出现：

- GitHub；
- `Review worker failed`；
- `Publish worker failed`；
- installation token URL；
- `api.github.com`。

### 2.2 Worker 禁用与 Demo queued 状态

`tests/e2e/full-stack.spec.ts:23-53` 已断言：

- ReviewWorker 未运行；
- PublishWorker 未运行；
- GitHub App 未配置；
- Demo mode 开启；
- seed 之后等待 1.2 秒仍存在 queued Job。

该项通过。

### 2.3 运行时版本纯函数

`scripts/baseline-runtime.mjs` 已拆分：

- `assertNodeBaseline()`
- `assertPythonBaseline()`

`scripts/verify-baseline.test.mjs` 已独立覆盖 Node 22/非 22 和 Python 3.12/非 3.12，不再依赖宿主先在哪个分支失败。

根 `npm test` 也已包含 `test:runtime-gate`。以上部分通过。

## 3. 剩余问题

### P1-1：新配置分支没有单元测试，`environment` 注入未用于默认 SettingsStore

#### 位置

- `apps/api/src/config/env.ts:19-22`
- `apps/api/src/config/runtime.ts:21-28`
- `apps/api/src/config/env.test.ts`
- `apps/api/src/config/runtime.test.ts`

#### 现状

代码新增：

```ts
CONSISTENCY_WORKERS_ENABLED
CONSISTENCY_SETTINGS_ROOT
CONSISTENCY_LOAD_ENV_FILE
```

但工作区搜索不到针对这些字段的单元测试。

`loadRuntimeConfig()` 当前签名：

```ts
export function loadRuntimeConfig(
  store = new SettingsStore(process.env.CONSISTENCY_SETTINGS_ROOT),
  environment: NodeJS.ProcessEnv = process.env
)
```

调用方如果传入：

```ts
loadRuntimeConfig(undefined, {
  CONSISTENCY_SETTINGS_ROOT: temporaryRoot,
  CONSISTENCY_LOAD_ENV_FILE: "false"
})
```

默认 SettingsStore 仍从全局 `process.env.CONSISTENCY_SETTINGS_ROOT` 构造，而不是传入的 `environment`。这破坏了函数提供的环境注入边界，也容易使单元测试误读真实项目配置。

此外，当传入自定义 `environment` 且允许加载 `.env` 时，`loadNearestEnvFile()` 修改的是全局 `process.env`，后续 `loadEnv()` 使用的却仍是传入对象；加载结果不会进入该对象。

#### 确定修复

改为先解析环境，再构造默认 store：

```ts
export function loadRuntimeConfig(
  store: SettingsStore | undefined = undefined,
  environment: NodeJS.ProcessEnv = process.env
): { config: AppConfig; store: SettingsStore } {
  const resolvedStore = store ?? new SettingsStore(environment.CONSISTENCY_SETTINGS_ROOT);

  if (environment.CONSISTENCY_LOAD_ENV_FILE !== "false") {
    if (environment !== process.env) {
      throw new Error("Custom environment requires CONSISTENCY_LOAD_ENV_FILE=false");
    }
    loadNearestEnvFile();
  }

  return {
    config: loadEnv(resolvedStore.effectiveEnvironment(environment)),
    store: resolvedStore
  };
}
```

也可以实现真正把 `.env` 解析到自定义对象的纯函数，但不能继续让“自定义 environment + 全局副作用”产生两套不同环境。

必须增加以下测试：

1. `CONSISTENCY_WORKERS_ENABLED` 缺省为 `true`；
2. 字符串 `"false"` 解析为布尔 `false`；
3. 非法值如 `"0"`、`"yes"` 被拒绝；
4. `CONSISTENCY_SETTINGS_ROOT=<temp>` 时只读取临时 SettingsStore；
5. `CONSISTENCY_LOAD_ENV_FILE=false` 时不会加载项目 `.env`；
6. 自定义环境不会访问真实 `.consistency`。

`CONSISTENCY_WORKERS_ENABLED` 还应补入 `.env.example` 和运行配置文档。

### P1-2：缺失 Python executable failure 测试

#### 位置

- `scripts/baseline-runtime.mjs:1-13`
- `scripts/verify-baseline.mjs:6-13`
- `scripts/verify-baseline.test.mjs:4-18`

#### 现状

纯函数测试已覆盖版本字符串，但没有覆盖：

```text
CONSISTENCY_PYTHON_PATH 指向不存在文件
Python 子进程无法启动
Python 版本查询返回非预期输出
```

上一轮报告明确要求“Python 命令不存在 -> 非零”。本轮把旧的 `execFileSync` 负向测试删除后，没有提供等价替代。

#### 确定修复

把查询逻辑抽成可注入函数：

```js
import { execFileSync } from "node:child_process";

export function queryPythonVersion(
  python,
  execute = execFileSync
) {
  return execute(
    python,
    ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],
    { encoding: "utf8" }
  ).trim();
}
```

测试：

```js
it("propagates a missing Python executable", () => {
  const missing = () => {
    const error = new Error("spawn ENOENT");
    error.code = "ENOENT";
    throw error;
  };
  expect(() => queryPythonVersion("missing-python", missing)).toThrow(/ENOENT/);
});

it("rejects malformed Python version output", () => {
  const execute = () => "not-a-version";
  expect(() => assertPythonBaseline(queryPythonVersion("python", execute)))
    .toThrow(/Python 3.12/);
});
```

保留一个仅在 Node 22 基线中执行的进程级测试：

```text
CONSISTENCY_PYTHON_PATH=<nonexistent> node scripts/verify-baseline.mjs
```

退出码必须非 0。

### P1-3：徽标翻译与风险级别断言仍然是弱断言

#### 位置

- `tests/e2e/full-stack.spec.ts:67-74`
- `tests/e2e/full-stack.spec.ts:76-86`

#### 现状

中文状态徽标只检查：

```ts
await expect(page.locator(".badge").first()).toBeVisible();
```

这不能证明文本已翻译。即使徽标仍显示英文，测试也会通过。

风险断言：

```ts
await expect(page.locator(".report-score"))
  .toContainText(/score|Level|Drift|分|层级/i);
```

只检查标签词，不检查实际风险等级。

#### 确定修复

切换中文后：

```ts
await expect(
  page.locator(".badge").filter({
    hasText: /排队中|运行中|已成功|失败/
  }).first()
).toBeVisible();
```

切回英文后：

```ts
await expect(
  page.locator(".badge").filter({
    hasText: /Queued|Running|Succeeded|Failed/
  }).first()
).toBeVisible();
```

Report 页面必须检查实际风险值：

```ts
await expect(page.locator(".report-score"))
  .toContainText(/Critical|High|Medium|Low|严重|高|中|低/i);
```

如果 CSS 选择器不稳定，应在组件中增加语义化 `data-testid`，不要继续依赖宽泛 class 和标签词。

## 4. 最终固定基线尚未执行

附件环境仍是：

```text
Node 25.8.1
Python 3.11.9
```

本轮两次 E2E 可以证明隔离逻辑有效，但不能作为 Phase 7 固定基线证据。

完成上述 P1 修复后，必须在同一个 Node 22.x + Python 3.12.x shell 中执行：

```powershell
node -v
python --version
npm run verify:runtime
npm ci
npm run audit:deps
python -m pip install -r requirements-lock.txt
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

只有以上命令全部返回 0，并确认两轮 E2E 无外部请求、无 Worker error、无临时目录残留后，才允许：

1. 将 Phase 7 标记为 complete；
2. 创建 `v2`；
3. 提交；
4. 推送。
