# ConsistenCy V2 审计报告

## 1. 审计结论

**结论：BLOCK。Phase 7 不通过，不允许创建、提交或推送 `v2` 分支。**

本轮已建立真实的联合验收环境：

- Node.js `v22.23.2`
- Python `3.12.12`

并已用 Python 3.12 重新生成 `requirements-lock.txt`。但是在执行固定基线安装时，`npm ci` 报告 **1 个 high severity 漏洞**。只读的 `npm audit --json` 进一步确认，当前锁文件中的 `postcss@8.5.15` 命中 `GHSA-r28c-9q8g-f849`。此外，仓库仍没有可执行的 Playwright/E2E 脚本或 CI E2E 门禁，不能满足主计划中的 “Full Stack Integration, E2E Verification”。

根据审计规则，发现阻断项后停止后续验收。本轮没有执行 `npm audit fix`、没有自动升级依赖，也没有创建、提交或推送分支。

## 2. 阻断问题

### P0-1：锁文件固定了存在 high severity 漏洞的 `postcss@8.5.15`

#### 位置

- `package-lock.json:2806`：`node_modules/postcss`
- `package-lock.json:2807`：固定版本 `8.5.15`
- `package-lock.json:3861`：上游依赖 `vite@6.4.3`
- `package-lock.json:3871`：Vite 声明 `postcss: ^8.5.3`
- `package.json:33`：直接开发依赖 `vite`

#### 证据

在 Node.js `v22.23.2` 下执行：

```text
npm ci

1 high severity vulnerability
```

随后只读执行 `npm audit --json`：

```json
{
  "name": "postcss",
  "severity": "high",
  "title": "PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure",
  "url": "https://github.com/advisories/GHSA-r28c-9q8g-f849",
  "range": "<=8.5.17",
  "nodes": ["node_modules/postcss"],
  "fixAvailable": true
}
```

`npm ls postcss --all` 给出的实际依赖链为：

```text
consistency-workspace
└─┬ vite@6.4.3
  └── postcss@8.5.15
```

#### 为什么这是问题

该漏洞允许恶意 CSS 的 `sourceMappingURL` 触发路径遍历并读取任意 `.map` 文件。虽然 `postcss` 当前标记为开发依赖，但 ConsistenCy 的 CI 会检出并构建外部仓库内容；因此不能把构建工具链中的输入视为可信数据，也不能用“仅 devDependency”作为放行理由。

触发边界：

- Vite/PostCSS 处理攻击者可控 CSS；
- CSS 包含指向工作区外部文件的恶意 previous source map 路径；
- 构建或开发服务器进程对目标文件具有读取权限。

#### 确定修复

在根 `package.json` 中添加最小安全版本覆盖，并添加不可回退的审计门禁：

```diff
 {
   "scripts": {
+    "audit:deps": "npm audit --audit-level=high",
     "build": "npm run build --workspaces --if-present"
   },
+  "overrides": {
+    "postcss": "8.5.18"
+  },
   "devDependencies": {
```

然后必须在 Node 22.x 下重建并验证锁文件：

```powershell
npm install --package-lock-only
npm ci
npm ls postcss --all
npm run audit:deps
```

验收断言：

- `package-lock.json` 中 `node_modules/postcss.version >= 8.5.18`；
- `npm ls postcss --all` 不得出现 `postcss@8.5.17` 或更低版本；
- `npm audit --audit-level=high` 退出码为 `0`；
- 不允许用 `--force`、`--legacy-peer-deps`、`audit=false` 或忽略退出码绕过。

同时在 `.github/workflows/ci.yml` 的 `npm ci` 后加入：

```diff
       - name: Install TypeScript workspace dependencies
         run: npm ci
+
+      - name: Audit Node dependencies
+        run: npm run audit:deps
```

### P0-2：附件中的 “固定基线全部通过” 结论使用了错误运行时

#### 位置

- 附件执行记录开头：`node -v; python --version`
- `.nvmrc:1`：要求 Node 22
- `.node-version:1`：要求 Node 22
- `.python-version:1`：要求 Python 3.12
- `package.json:5-7`：`engines.node = 22.x`
- `.github/workflows/ci.yml:23-26`：Python 3.12
- `.github/workflows/ci.yml:45-49`：Node 22

#### 证据

附件真实输出为：

```text
Node version: v25.8.1
Python version: Python 3.11.9
```

但附件随后把同一环境运行的测试描述成 “All baseline tests passed 100%”。该结论不成立。版本文件和 `engines` 字段只表达期望，不会把已经启动的 Node 25 或 Python 3.11 自动切换为目标运行时。

本轮重新建立 Node `v22.23.2` + Python `3.12.12` 后，尚未完成全套测试就被 P0-1 的 high severity 依赖门禁阻断，因此当前也不能补写为 “Phase 7 passed”。

#### 确定修复

新增 `scripts/verify-baseline.mjs`，在执行测试前硬失败：

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

根 `package.json` 必须把该检查作为完整验收的前置步骤：

```diff
   "scripts": {
-    "verify": "npm run typecheck && npm test && npm run build && npm run test:python",
+    "verify:runtime": "node scripts/verify-baseline.mjs",
+    "verify": "npm run verify:runtime && npm run audit:deps && npm run typecheck && npm test && npm run build && npm run test:python",
   }
```

验收时必须在同一个 shell 中记录：

```powershell
node -v
python --version
npm run verify
```

不得拼接来自不同 shell、不同虚拟环境或不同测试轮次的结果。

## 3. 非阻断但必须在 Phase 7 关闭的问题

### P1-1：主计划要求 E2E，但仓库没有可执行的 E2E 门禁

#### 位置

- `package.json:30`：已安装 `playwright`
- `package.json:12-23`：没有 `test:e2e` 脚本
- `.github/workflows/ci.yml:51-65`：只执行安装、类型检查、单元测试、构建和 Python 测试
- 仓库中不存在 `playwright.config.ts`
- 仓库中不存在可执行的 `*.spec.ts` E2E 测试
- `output/playwright/*.png`：仅是生成结果，不能替代可重复测试源

#### 为什么这是问题

当前 Vitest 覆盖了模块和部分跨语言集成，但没有从浏览器验证：

```text
Web UI -> HTTP API -> SQLite JobStore -> Demo/Report API -> UI 渲染
```

截图无法证明测试如何启动服务、执行了哪些断言、失败时是否会使 CI 失败，也无法防止以后回归。

#### 确定修复

新增：

- `playwright.config.ts`
- `tests/e2e/full-stack.spec.ts`
- 根脚本 `"test:e2e": "playwright test"`

`playwright.config.ts` 必须：

- 启动 API：`npm run dev:api`
- 启动 Web：`npm run dev:web -- --port 5173`
- API 环境固定为 `NODE_ENV=test`、`LLM_PROVIDER=mock`
- `DATABASE_PATH`、`CONSISTENCY_WORKSPACE_ROOT` 使用每次运行独立的临时目录
- `CONSISTENCY_PYTHON_PATH` 明确指向 Python 3.12 解释器
- 测试结束后关闭两个 server，并删除自己的临时数据库/工作区

`tests/e2e/full-stack.spec.ts` 至少必须断言：

1. 浏览器打开 Web 后，`/health` 返回 `ok: true` 且 `demoMode: true`；
2. 点击 “Load demo data” 会通过真实 HTTP API 创建 Job，而不是使用前端内置 mock 数据；
3. Jobs 页面显示新 Job，Report 页面能读取并渲染对应报告；
4. 英文/中文切换和关键发布状态徽标可见；
5. 浏览器控制台无未处理异常，所有 API 响应均通过前端 schema；
6. 整个测试不访问真实 GitHub 或真实 LLM 网络端点。

根脚本和 CI 增加：

```diff
   "scripts": {
+    "test:e2e": "playwright test",
-    "verify": "... && npm run test:python"
+    "verify": "... && npm run test:python && npm run test:e2e"
   }
```

```diff
+      - name: Install Playwright browser
+        run: npx playwright install --with-deps chromium
+
+      - name: Full-stack E2E
+        run: npm run test:e2e
```

## 4. 已完成但不能单独构成验收的工作

本轮已使用 Python `3.12.12` 执行：

```text
uv pip compile --python 3.12 requirements-dev.txt --output-file requirements-lock.txt --upgrade
```

新 `requirements-lock.txt` 已移除 “generated with Python 3.11” 的错误头，并只保留当前 V2 依赖及其传递依赖。该锁文件仍需在修复 P0-1 后，与 Node 22 的完整门禁一起重新验证。

`pyproject.toml` 中 `requires-python = ">=3.11"` 表示包的支持范围，不等同于 Phase 7 的固定验收运行时。本报告不要求仅为验收而把包的兼容范围强制缩窄到 Python 3.12；固定基线由运行时门禁和 CI 负责。

## 5. Gemini 修复后的唯一放行顺序

必须严格按以下顺序执行：

```powershell
node -v
python --version
npm install --package-lock-only
npm ci
npm run audit:deps
npm run verify:runtime
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

放行条件：

- Node 必须是 `22.x`，Python 必须是 `3.12.x`；
- `npm audit --audit-level=high` 为 0；
- 所有命令退出码为 0；
- Playwright E2E 是可重复测试，不是手工截图；
- `git diff --check` 为 0；
- 完成上述全部条件前，不得把 Phase 7 标记为 Approved/Complete，不得创建或推送 `v2`。
