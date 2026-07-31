# ConsistenCy V2 Phase 7 Redo 验收审计报告

## 1. 终验结论

**结论：BLOCK。Phase 7 Redo 未通过。**

已确认 `postcss` 漏洞修复有效：

```text
npm ls postcss --all
└─┬ vite@6.4.3
  └── postcss@8.5.18 overridden

npm run audit:deps
found 0 vulnerabilities
```

但是另外两项核心门禁被实现成了可绕过的“伪门禁”：

1. 固定运行时检查在 Node 25 / Python 非 3.12 时仍返回退出码 0；
2. Playwright 测试没有隔离数据库、允许复用任意旧服务，并且实际上没有打开或验证任何 Review Report。

附件中“Phase 7 APPROVED & COMPLETE”和“Release Verification Sequence Passed”的结论不成立。本轮发现阻断项后停止，没有创建、提交或推送 `v2` 分支。

## 2. 已通过项目

### P0-1：PostCSS high severity 漏洞已修复

#### 当前实现

- `package.json:28-30`：固定覆盖 `postcss@8.5.18`
- `package.json:19`：增加 `audit:deps`
- `.github/workflows/ci.yml:54-55`：CI 执行依赖审计
- `package-lock.json`：解析到 `postcss@8.5.18`

#### 结论

该项通过，无需重复修改。

## 3. 阻断问题

### P0-1：`verify:runtime` 是 fail-open，错误运行时仍然通过

#### 位置

- `package.json:5-7`
- `package.json:20-21`
- `scripts/verify-baseline.mjs:3`
- `scripts/verify-baseline.mjs:8-15`
- `scripts/verify-baseline.mjs:19-38`
- `.npmrc:2`
- `.github/workflows/ci.yml:45-55`

#### 确定性复现

当前 shell：

```text
node -v
v25.8.1

python --version
Python 3.11.9
```

执行当前门禁：

```text
npm run verify:runtime

[WARN] Node 22.x required for baseline verification, got v25.8.1
[WARN] Python 3.12.x required for baseline verification, got unknown
Baseline runtime check: Node v25.8.1, Python unknown
exit=0
```

这证明该脚本不是门禁。更严重的是，Python 查询本身已经失败并产生 `unknown`，脚本仍然成功退出。

#### 根因

1. `scripts/verify-baseline.mjs:3` 只在 `CI=true` 或手动设置 `CONSISTENCY_STRICT_RUNTIME=1` 时严格检查；
2. `scripts/verify-baseline.mjs:12-14` 和 `35-37` 把版本错误降级为警告；
3. `scripts/verify-baseline.mjs:25-29` 在非 strict 模式吞掉 Python 启动/查询异常；
4. `package.json:6` 被从严格的 `"22.x"` 放宽成 `" >=22.0.0"`，使 `.npmrc` 的 `engine-strict=true` 接受 Node 25；
5. `.github/workflows/ci.yml` 没有执行 `npm run verify:runtime`。CI 虽然通过 setup actions 请求目标版本，但没有对实际运行时做断言。

附件声称审计报告允许本地警告模式，但上一版正式审计报告给出的代码是无条件 `throw`，没有 `allowFlex` 或 `strictMode` 分支。该放宽属于未获批准的需求变更。

#### 为什么这是阻断项

Phase 7 的唯一目标是固定在 Node 22.x + Python 3.12.x 上验收。如果版本不匹配仍返回 0，则后面的测试即使全绿，也不能证明固定基线兼容。

#### 确定修复

恢复严格引擎范围：

```diff
   "engines": {
-    "node": ">=22.0.0"
+    "node": "22.x"
   },
```

完整替换 `scripts/verify-baseline.mjs`：

```js
import { execFileSync } from "node:child_process";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) {
  throw new Error(`Node 22.x required, got ${process.version}`);
}

const python = process.env.CONSISTENCY_PYTHON_PATH ?? "python";
const pythonVersion = execFileSync(
  python,
  ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],
  { encoding: "utf8" }
).trim();

if (!pythonVersion.startsWith("3.12.")) {
  throw new Error(`Python 3.12.x required, got ${pythonVersion}`);
}

console.log(`Baseline runtime verified: Node ${process.versions.node}, Python ${pythonVersion}`);
```

要求：

- 删除 `strictMode`；
- 删除所有仅警告后继续的分支；
- Python 无法启动或无法查询版本时必须保留非零退出码；
- 如果需要宽松的开发环境提示，应放进另一个 `doctor` 命令，绝不能复用 `verify:runtime`。

在 `.github/workflows/ci.yml` 的 Setup Node 后、`npm ci` 前增加：

```diff
       - name: Setup Node
         uses: actions/setup-node@v4
         with:
           node-version: "22"
           cache: npm
+
+      - name: Verify fixed runtime baseline
+        run: npm run verify:runtime
```

增加 `scripts/verify-baseline.test.mjs` 或等价测试，至少覆盖：

- Node 22 + Python 3.12：退出 0；
- Node 非 22：退出非 0；
- Python 非 3.12：退出非 0；
- Python 命令不存在：退出非 0。

### P0-2：Playwright “Full-Stack E2E” 可复用旧状态，且没有测试 Report

#### 位置

- `playwright.config.ts:20-43`
- `playwright.config.ts:24`
- `playwright.config.ts:27-31`
- `playwright.config.ts:36`
- `apps/api/src/config/env.ts:13-17`
- `tests/e2e/full-stack.spec.ts:4`
- `tests/e2e/full-stack.spec.ts:19-23`
- `tests/e2e/full-stack.spec.ts:25-40`

#### 问题 A：使用共享数据库与共享工作区

API webServer 环境只设置：

```ts
{
  PORT: "3001",
  HOST: "127.0.0.1",
  LLM_PROVIDER: "mock"
}
```

没有设置：

- `DATABASE_PATH`
- `CONSISTENCY_WORKSPACE_ROOT`
- `CONSISTENCY_PYTHON_PATH`

因此 API 会回落到：

```text
.consistency/consistency.db
.consistency/workspaces
python
```

这会读取或修改开发者已有状态，并可能调用系统 Python 3.11。测试结果依赖执行前数据库里是否已经存在 Job。

#### 问题 B：本地允许复用任意旧服务

`playwright.config.ts:24` 和 `36`：

```ts
reuseExistingServer: !process.env.CI
```

本地所谓“Release Verification”可以直接连接端口 3001/5173 上早已运行的其他版本、其他配置或其他数据库实例。Playwright 不会证明当前代码启动成功。

#### 问题 C：Demo seed 可以完全跳过

`tests/e2e/full-stack.spec.ts:20-23`：

```ts
const loadDemoButton = page.locator("button:has-text('Load demo data')");
if (await loadDemoButton.isVisible()) {
  await loadDemoButton.click();
}
```

如果共享数据库已有 Job，按钮不可见，关键创建步骤被静默跳过，测试仍然通过。测试没有等待和断言 `POST /demo/seed` 返回 201。

#### 问题 D：测试名称声称验证 reports，实际从未打开 Report

测试只执行：

```text
Health -> Dashboard -> Jobs 标题 -> Settings -> 语言切换
```

它没有：

- 断言 Jobs 列表存在新建 Job；
- 点击任何 Job；
- 打开 Report 页面；
- 断言报告 summary、findings、riskLevel 或 agent runs；
- 验证发布状态徽标；
- 捕获 `pageerror` 或浏览器 console error；
- 阻止真实 GitHub/LLM 外部请求；
- 断言 `/health.configuration.demoMode === true`。

因此 `1/1 passed` 只能证明几个页面标题能显示，不能证明完整数据链路。

#### 确定修复

`playwright.config.ts` 必须为每次运行创建唯一临时根目录，并禁止复用服务。示例结构：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2eRoot = mkdtempSync(join(tmpdir(), "consistency-e2e-"));
const databasePath = join(e2eRoot, "consistency.db");
const workspaceRoot = join(e2eRoot, "workspaces");

process.once("exit", () => {
  rmSync(e2eRoot, { recursive: true, force: true });
});

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] }
  }],
  webServer: [
    {
      command: "npm run dev:api",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      env: {
        NODE_ENV: "development",
        PORT: "3001",
        HOST: "127.0.0.1",
        LLM_PROVIDER: "mock",
        DATABASE_PATH: databasePath,
        CONSISTENCY_WORKSPACE_ROOT: workspaceRoot,
        CONSISTENCY_PYTHON_PATH: process.env.CONSISTENCY_PYTHON_PATH ?? "python"
      }
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      env: {
        VITE_API_BASE_URL: "http://127.0.0.1:3001"
      }
    }
  ]
});
```

说明：

- 当前 `server.ts` 在 `NODE_ENV=test` 时不监听端口，因此 E2E 可继续使用 `development`，但必须显式设置独立状态路径；
- `npm run verify:runtime` 已经保证 `CONSISTENCY_PYTHON_PATH` 指向 Python 3.12；
- 如果要并发执行 E2E，应进一步改成动态端口，不能共享 3001/5173。

完整替换 `tests/e2e/full-stack.spec.ts` 的核心流程，必须包含以下确定性断言：

1. 安装 `page.on("pageerror")` 和 `page.on("console")` 收集未处理错误；
2. `/health` 必须断言 `ok === true`、`configuration.demoMode === true`；
3. 首屏必须出现 “Load demo data”，否则失败；
4. 在点击前注册 `page.waitForResponse`，断言 `POST /demo/seed` 返回 201；
5. 打开 Jobs 页面，断言至少一个确定的 demo Job；
6. 点击该 Job 或对应报告入口；
7. Report 页面断言 summary、至少一个 finding、risk level、agent runs；
8. 切换语言并断言关键状态徽标翻译；
9. 断言没有 `pageerror` 或 console error；
10. 记录所有 request，断言 host 只能是 `127.0.0.1:5173` 或 `127.0.0.1:3001`，禁止访问真实 GitHub/LLM。

不得再使用：

```ts
if (await loadDemoButton.isVisible()) { ... }
```

必须改为：

```ts
await expect(loadDemoButton).toBeVisible();
```

## 4. 状态文档错误

### P1-1：尚未通过终验却标记为完成

#### 位置

- `task.md:9`：Phase 7 标记 `[x]`
- `implementation_plan.md:17`：标记 `APPROVED & COMPLETE`

#### 确定修复

在以上 P0 修复完成并重新验收前，必须恢复为：

```text
- [/] Phase 7: Baseline Verification (Node 22.x / Python 3.12.x)
```

```text
Phase 7 ... — REDO IN PROGRESS
```

不能依据错误运行时上的本地测试或不隔离的 E2E 测试把状态标记为完成。

## 5. P2 清理建议

`package.json` 同时直接依赖：

```json
"@playwright/test": "^1.49.1",
"playwright": "^1.61.1"
```

当前两者都解析为 `1.62.1`，不会立即失败，但 `@playwright/test` 已经依赖匹配版本的 `playwright`。建议只保留：

```json
"@playwright/test": "^1.62.1"
```

随后重建 lockfile，减少版本漂移和重复声明。

## 6. Redo 后唯一验收顺序

必须在同一个严格 shell 中执行：

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
git diff --check
```

必须补充负向门禁证据：

```text
Node 非 22 -> verify:runtime 非零
Python 非 3.12 -> verify:runtime 非零
Python 不存在 -> verify:runtime 非零
E2E 第二次连续运行 -> 使用不同临时数据库且仍通过
端口已有旧服务 -> E2E 明确失败，不得复用
```

全部通过前：

- 不得标记 Phase 7 complete；
- 不得创建 `v2`；
- 不得提交；
- 不得推送。
