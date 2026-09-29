# ConsistenCy v3 → v4 迁移记录（delivery-readiness）

v3 时期的逐批交付审计矩阵（批次一～六的逐项现状表、桌面打包与 Playwright 记录）已被本文件取代：那些批次记录描述的组件在 v4 已全部删除，其证据日志（`.omo/evidence/**`）也已不在仓库内。原始逐批审计记录与逐项 file:line 结论只在 git 历史里，本文不复述，只记录 v3 → v4 的真实差异与当前可核验的交付事实。

## 一、v4 删除的组件

| 删除对象 | 原角色 |
|---|---|
| `apps/web` | React/Vite Web UI |
| `apps/desktop` | Electron Windows 桌面宿主与打包管线 |
| `packages/ui` | Web UI 组件库 |
| `packages/web-host` | Web 宿主 |
| `tests/e2e` | Playwright 浏览器端到端测试 |
| `tests/e2e-electron` | Electron 端到端测试 |
| playwright 配置、desktop 打包脚本 | 对应的测试与打包入口 |

根 `package.json` 中已不存在 `dev:web`、`desktop:dev`、`desktop:pack`、`test:desktop`、`test:e2e` 脚本，根 `dependencies` 只剩 `zod`。

`apps/desktop/` 下只剩一个文件：`apps/desktop/staged/runtime/python/Lib/site-packages/pip/_internal/commands/configuration.py`。它**不是可删残留，而是被测数据钉住的夹具来源**——`engine/evaluation/scoring_cases.json` 的样本 `frag_pip_shell_true` 用绝对路径引用它（`source_lines: [234, 252]`、`slice_sha256: 18cce05aff2a853079151b01a1c6cd6cca8a8e91b2ade521313c0bbbb898843b`），Python 测试会校验该文件存在及其切片哈希。移动或删除它会让 `tests/test_scoring_rules.py` 的 provenance 校验失败，因此这个路径必须保持原位。

## 二、随之不再存在的能力

- 任何图形界面：Web UI、桌面宿主、报告页面、网页端取消按钮、`apps/web` 构建产物。
- 桌面打包、安装包分发与安装态冒烟；浏览器端到端测试也一并消失。
- Notebook 的仓库内界面：`apps/api/src/notebook/` 的 API 仍在，但没有随仓库提供的 UI，只能经 HTTP 使用。

## 三、保留并迁移到终端入口的能力

- 主入口：`npm run consistency` → `tsx apps/cli/src/main.ts`，命令只有 `review` 与 `help`（`--help` / `-h`）；未知命令退出 2。`npm run review` 等价于直接运行 `review`。
- `consistency review` 选项：`--repo <路径>`（默认当前目录）、`--base <ref>` / `--head <ref>`（只传 `--base` 自动补 `HEAD`；只传 `--head` 报错）、`--json`、`--verbose`、`--limit <n>`、`--all`、`--no-color` / `--color`、`--language <zh-CN|en-US>`、`--threshold <critical|high|medium|low|info>`（默认 `low`）、`--provider <名>`、`--model <名>`。
- 审查实现：终端与 HTTP daemon（`apps/api`）共用同一套 `createReviewRuntime`，终端侧在 `apps/cli/src/review.ts` 复用而不重实现；HTTP/队列/持久化层仍在仓库里，只是没有界面。
- 渲染纪律：约束块永远存在（`[!]` 表示该部分本次未检查，不代表已检查通过；`[~]` 表示已检查但证据链不完整）；`score`/`riskLevel` 与 `riskBand` 两个风险度量并排且永不合并；没有覆盖记录时不打绿勾，只写「本次审查未记录覆盖范围」。
- 配置入口：`npm run setup`、`npm run config -- show|doctor|set`。LLM 运行时只允许真实 provider（DeepSeek / OpenAI / Anthropic）。
- GitHub App 未配置时：本地审查与公开 PR 分析仍可用；webhook PR 与 GitHub 评论发布不可用。

## 四、当前验证方式

`npm run verify` = `verify:runtime` → `verify:docs` → `audit:deps` → `typecheck` → `test` → `build` → `test:python`。其中 `npm run verify:docs`、`npm run audit:deps`、`npm run test:python` 也可单独运行。

退出码契约（唯一判定点 `apps/cli/src/report.ts:425` 的 `exitCodeFor`）：

| 码 | 含义 |
|---|---|
| 0 | 跑完，没有任何 finding 达到阈值 |
| 1 | 跑完，有 finding 达到阈值（可作 CI 闸门） |
| 2 | 没跑成，或本次审查覆盖不完整（不可当闸门信任） |

环境硬约束：Node.js `>=22.19.0 <23`（根 `package.json` 的 `engines`）与 Python 3.12.x；`npm run verify:runtime` 需要 `CONSISTENCY_PYTHON_PATH` 指向 `.venv`，否则报 Python 3.12.x required。依赖安装用 `npm ci`。

v3 的交付阻塞（桌面打包 clean-tree 门闸、安装包分发、Playwright 结果）随对应组件的删除而失效，不再作为当前结论。
