# ConsistenCy V2 Phase 7 Redo 2 验收审计报告

## 1. 结论

**结论：BLOCK。Phase 7 仍不得标记完成，不得创建、提交或推送 `v2`。**

本轮确认以下修复已经有效：

- `package.json` 已恢复 `engines.node = "22.x"`；
- `scripts/verify-baseline.mjs` 已改为无条件硬失败；
- Playwright 已使用独立临时数据库和工作区；
- `reuseExistingServer` 已关闭；
- E2E 已真正 seed 数据、打开 Job/Report，并验证 finding 与 agent timeline；
- 连续执行两轮 E2E 均通过，且两轮结束后没有残留 `consistency-e2e-*` 临时目录；
- PostCSS 依赖审计保持 0 漏洞。

但是 E2E 期间后台 API 进程真实访问了 GitHub。两轮测试均打印 GitHub installation token 请求失败，而 Playwright 仍返回通过。这直接违反“零外部请求”的验收条件，也证明当前网络隔离断言只覆盖浏览器、不覆盖服务端。

此外，运行时门禁测试没有独立覆盖 Node/Python 分支，且不在根 `npm test`/CI 测试集合中。附件仍然是在 Node 25.8.1 / Python 3.11.9 下运行测试，不能形成最终固定基线证据。

## 2. 已通过项目

### 2.1 固定运行时实现已从 fail-open 改为 fail-closed

位置：

- `package.json:5-7`
- `scripts/verify-baseline.mjs:3-19`
- `.github/workflows/ci.yml:45-55`

当前 shell 为 Node 25.8.1，执行：

```text
npm run verify:runtime
verify_runtime_exit=1
```

该负向行为正确。

### 2.2 E2E 状态隔离与连续运行已通过

位置：

- `playwright.config.ts:6-12`
- `playwright.config.ts:28-55`
- `tests/e2e/full-stack.spec.ts:35-57`

动态复核结果：

```text
first_exit=0
after_first:  无 consistency-e2e-* 目录

second_exit=0
after_second: 无 consistency-e2e-* 目录
```

两轮均从空库出现 “Load demo data” 并成功打开 Report。临时数据库隔离、禁止复用服务和正常退出清理三项通过。

## 3. 阻断问题

### P0-1：E2E 真实访问 GitHub，但“零外部请求”断言仍然通过

#### 位置

- `tests/e2e/full-stack.spec.ts:15-21`
- `tests/e2e/full-stack.spec.ts:72-75`
- `playwright.config.ts:35-43`
- `apps/api/src/config/runtime.ts:7-23`
- `apps/api/src/config/settings.ts:119-132`
- `apps/api/src/config/settings.ts:177-185`
- `apps/api/src/api/demoSeed.ts:5-13`
- `apps/api/src/api/demoSeed.ts:27-35`
- `apps/api/src/server.ts:35-50`
- `apps/api/src/server.ts:172-175`
- `apps/api/src/jobs/worker.ts:76-86`

#### 动态证据

连续两次运行 `npx playwright test`，每次均显示测试通过，但 API server 都输出：

```text
Review worker failed a job
error: Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app
```

第一次：

```text
jobId: job_08c0586b-1dc3-4af2-8497-63dd112f68a0
1 passed
```

第二次：

```text
jobId: job_697d5ea1-339d-4244-9b65-15d4285d1fd4
1 passed
```

测试通过与服务端外部访问失败同时发生，属于确定性假绿。

#### 根因 1：网络监听只存在于浏览器

当前代码：

```ts
page.on("request", req => {
  // 只观察 Chromium 发出的请求
});
```

该监听器无法看到 Node API、ReviewWorker、Octokit 或 Python 子进程发出的网络请求。

#### 根因 2：E2E 仍读取真实项目配置和 `.env`

虽然数据库路径已隔离，但 `loadRuntimeConfig()` 仍会：

1. 从项目根目录加载最近的 `.env`；
2. 使用默认 `new SettingsStore()`；
3. 读取项目真实的 `.consistency/config.json` 和 `.consistency/secrets.enc.json`；
4. 用真实 GitHub App 配置构造 `GitHubAppAuthenticator`。

`playwright.config.ts` 没有隔离 SettingsStore，也没有禁止加载项目 `.env`。

#### 根因 3：Demo seed 创建可领取的 queued Job，development 模式会启动 Worker

`seedDemoData()` 明确创建：

```text
running
queued
```

而 Playwright 为了让 server 监听端口使用 `NODE_ENV=development`。`server.ts` 随即启动 ReviewWorker 和 PublishWorker；ReviewWorker 会领取 demo queued Job，并尝试通过真实 GitHub App 获取 PR 上下文。

#### 为什么这是 P0

- 测试对真实外部系统产生请求；
- 可能消耗 GitHub API 配额；
- 可能使用开发者真实凭据；
- 测试运行结果受外部 GitHub 状态影响；
- 后台 Job 已失败，但 UI 断言完成得更早，因此测试仍为绿色；
- “不访问真实 GitHub/LLM”是 Phase 7 的明确门禁。

#### 确定修复

必须同时隔离配置来源并关闭 E2E 后台 Worker，不能只在测试里忽略日志。

##### A. 为运行时配置增加可测试的配置根与 `.env` 开关

在 `apps/api/src/config/runtime.ts` 中改为：

```ts
export function loadRuntimeConfig(
  store = new SettingsStore(process.env.CONSISTENCY_SETTINGS_ROOT),
  environment: NodeJS.ProcessEnv = process.env
): { config: AppConfig; store: SettingsStore } {
  if (environment.CONSISTENCY_LOAD_ENV_FILE !== "false") {
    loadNearestEnvFile();
  }
  return { config: loadEnv(store.effectiveEnvironment(environment)), store };
}
```

要求为以下行为增加单元测试：

- `CONSISTENCY_SETTINGS_ROOT=<temp>` 时只读取临时配置目录；
- `CONSISTENCY_LOAD_ENV_FILE=false` 时不读取项目 `.env`；
- 默认生产行为保持不变。

##### B. 增加显式 Worker 启停配置

在 `apps/api/src/config/env.ts` 增加严格布尔配置，例如：

```ts
CONSISTENCY_WORKERS_ENABLED: z
  .enum(["true", "false"])
  .transform(value => value === "true")
  .default("true"),
```

在 `apps/api/src/server.ts:172-175` 改为：

```ts
if (process.env.NODE_ENV !== "test") {
  if (config.CONSISTENCY_WORKERS_ENABLED) {
    worker.start();
    publishWorker.start();
  }
  server.listen(config.PORT, config.HOST, () => {
    // existing log
  });
}
```

必须增加测试，断言 `CONSISTENCY_WORKERS_ENABLED=false` 时：

- ReviewWorker 不启动；
- PublishWorker 不启动；
- HTTP server 仍正常监听；
- `/health.worker.running === false`；
- `/health.publishWorker.running === false`。

##### C. Playwright 使用完全隔离的 API 环境

在 `playwright.config.ts` 的 API `env` 中加入：

```ts
CONSISTENCY_SETTINGS_ROOT: e2eRoot,
CONSISTENCY_LOAD_ENV_FILE: "false",
CONSISTENCY_WORKERS_ENABLED: "false",
GITHUB_APP_ID: "",
GITHUB_PRIVATE_KEY: "",
GITHUB_WEBHOOK_SECRET: "",
DEEPSEEK_API_KEY: "",
OPENAI_API_KEY: "",
CONSISTENCY_API_TOKEN: "",
```

保留现有：

```ts
DATABASE_PATH: databasePath,
CONSISTENCY_WORKSPACE_ROOT: workspaceRoot,
LLM_PROVIDER: "mock",
```

空字符串用于显式覆盖调用 shell 中可能存在的敏感环境变量；`optionalSecret` 会把空字符串转成 `undefined`。

##### D. E2E 验证 Worker 确实关闭

在 health 断言中加入：

```ts
expect(healthData.worker.running).toBe(false);
expect(healthData.publishWorker.running).toBe(false);
expect(healthData.configuration.githubAppConfigured).toBe(false);
```

Demo seed 后等待超过默认 poll interval，再重新读取 Job 列表，断言 demo queued Job 仍为 `queued`，不能变为 `running` 或 `failed`。

不得通过删除错误日志、放宽断言、缩短等待时间或 mock 掉测试输出解决该问题。

### P1-1：运行时门禁测试存在控制流假阳性，且未进入 `npm test`/CI

#### 位置

- `scripts/verify-baseline.test.mjs:7-26`
- `package.json:14-21`
- `.github/workflows/ci.yml:60-64`

#### 问题 1：所谓 Python 无效路径测试先被 Node 版本拦截

测试执行：

```ts
execFileSync(process.execPath, [SCRIPT_PATH], {
  env: { ...process.env, CONSISTENCY_PYTHON_PATH: "non_existent_python_binary_xyz" }
});
```

当前测试宿主是 Node 25.8.1。因此子进程先在：

```js
if (nodeMajor !== 22) throw ...
```

失败，永远不会运行到 Python `execFileSync`。测试虽然通过，但无法证明无效 Python 路径会失败。

沙箱外复核输出：

```text
Tests 2 passed

Error: Node 22.x required, got v25.8.1
```

该错误正是第一个测试“通过”的原因。

#### 问题 2：缺少报告要求的独立场景

当前只有：

- 一个 `toThrow()`；
- 一个源码字符串扫描。

没有独立验证：

- Node 22 + Python 3.12 成功；
- Node 非 22 失败；
- Node 22 + Python 3.11 失败；
- Node 22 + Python 命令不存在失败。

#### 问题 3：根 `npm test` 不会运行该测试

根脚本：

```json
"test": "npm run test --workspaces --if-present"
```

只运行 `apps/*` 与 `packages/*` 的测试。`scripts/verify-baseline.test.mjs` 位于 workspace 外，不属于 `npm test`，CI 也没有单独执行它。

附件先运行 `npm test`，再手工运行 `npx vitest run scripts/verify-baseline.test.mjs`，不能证明 CI 会持续执行这项门禁测试。

#### 确定修复

将版本判断抽成无副作用纯函数。例如新增 `scripts/baseline-runtime.mjs`：

```js
export function assertNodeBaseline(version) {
  const major = Number(version.split(".")[0]);
  if (major !== 22) throw new Error(`Node 22.x required, got ${version}`);
}

export function assertPythonBaseline(version) {
  if (!version.startsWith("3.12.")) {
    throw new Error(`Python 3.12.x required, got ${version}`);
  }
}
```

`verify-baseline.mjs` 调用这两个函数并保留真实 `execFileSync`。测试必须分别调用纯函数，不能依赖当前宿主版本决定先失败在哪一层。

测试至少增加：

```ts
expect(() => assertNodeBaseline("22.23.2")).not.toThrow();
expect(() => assertNodeBaseline("25.8.1")).toThrow(/Node 22/);
expect(() => assertPythonBaseline("3.12.12")).not.toThrow();
expect(() => assertPythonBaseline("3.11.9")).toThrow(/Python 3.12/);
```

并在 Node 22 环境保留一个集成测试，使用不存在的 `CONSISTENCY_PYTHON_PATH` 验证进程退出非零。

把测试纳入默认门禁：

```diff
   "scripts": {
-    "test": "npm run test --workspaces --if-present",
+    "test:workspaces": "npm run test --workspaces --if-present",
+    "test:runtime-gate": "vitest run scripts/verify-baseline.test.mjs",
+    "test": "npm run test:workspaces && npm run test:runtime-gate",
   }
```

CI 保持 `npm test` 即可自动覆盖，不允许依赖手工额外命令。

### P1-2：E2E 尚未覆盖承诺的 summary、risk 文本和状态徽标翻译

#### 位置

- `tests/e2e/full-stack.spec.ts:51-57`
- `tests/e2e/full-stack.spec.ts:64-70`

当前只验证元素存在：

```ts
.report-score
.finding-item
.agent-timeline
```

没有断言：

- canonical summary 的非空文本；
- risk level 的具体值；
- agent run 数量或名称；
- Job 状态徽标的中文/英文翻译。

语言切换发生在 Settings 页面，只验证页面标题，不验证状态徽标。

#### 确定修复

Report 页面至少断言：

```ts
await expect(page.locator(".report-summary")).not.toHaveText("");
await expect(page.locator(".report-score")).toContainText(/Low|Medium|High|Critical|低|中|高|严重/i);
await expect(page.locator(".agent-run")).toHaveCount(expectedAgentCount);
```

选择器必须以实际 DOM 为准；如果 summary 没有稳定 class，应先在 `ReportPage.tsx` 增加语义化 class 或 `data-testid`。

语言切换后返回 Jobs 页面，分别断言至少一个 `.status-badge` 的中英文状态文本。

## 4. 固定基线证据仍未完成

附件本轮环境仍为：

```text
Node v25.8.1
Python 3.11.9
```

严格脚本会正确拒绝该环境。因此附件列出的：

```text
npm test
npx playwright test
```

只能作为非基线开发验证，不能作为 Phase 7 最终通过证据。

修复上述问题后，必须在同一个 Node 22.x + Python 3.12.x shell 中运行：

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

验收时必须确认：

- 两轮 E2E 都没有任何 GitHub/LLM 请求或 ReviewWorker failure 日志；
- 两轮均使用不同临时目录；
- 两轮结束后临时目录均被删除；
- queued demo Job 在测试结束前仍为 queued；
- 所有门禁退出码为 0。

完成以上全部要求前，`task.md` 必须保持 `[/]`，`implementation_plan.md` 必须保持 `REDO IN PROGRESS`。
