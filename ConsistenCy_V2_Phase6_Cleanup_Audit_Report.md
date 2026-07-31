# ConsistenCy V2 Phase 6 Cleanup 审计报告

## 结论

**Phase 6 暂不通过。**

以下三项删除已确认正确：

- `apps/api/src/publish/publisher.ts`
- `apps/api/src/publish/dbPublisher.ts`
- `apps/api/src/github/comment.ts`

它们已不存在，生产源码中也没有残留 import。

但是 Phase 6 的目标是删除 V1 CLI、直发路径、孤儿文件和旧依赖，而当前仓库仍保留多条可复现失败的 V1 入口、无调用者的兼容层、`backend` 假依赖和已删除源码的字节码缓存。现有 TypeScript/Python 测试没有覆盖这些入口，所以测试全绿不能证明 Cleanup 完成。

---

## P0-1：仓库仍公开并保留会立即崩溃的 V1 入口

### 受影响文件

- `examples/multi_agent_demo.py:11-15`
- `evaluation/scripts/generate_pr_report.py:12-16`
- `evaluation/scripts/run_ablation.py:13-17`
- `evaluation/scripts/run_public_pr_reports.py:40`
- `CONTRIBUTING.md:26`
- `.github/PULL_REQUEST_TEMPLATE.md:7`
- `evaluation/README.md:20`
- `docs/REMOTE_ANALYSIS.md:10`

### 动态证据

以下三条当前均以退出码 1 失败：

```text
python examples/multi_agent_demo.py
ModuleNotFoundError: No module named 'src.pipeline'

python evaluation/scripts/generate_pr_report.py --help
ModuleNotFoundError: No module named 'src.pipeline'

python evaluation/scripts/run_ablation.py --help
ModuleNotFoundError: No module named 'src.evaluation'
```

`evaluation/scripts/run_public_pr_reports.py` 仍把已删除的 `backend/cli.py` 固定为执行入口：

```py
BACKEND_CLI = PROJECT_ROOT / "backend" / "cli.py"
```

这意味着 Phase 6 删除 V1 实现后，仍留下了指向已删除实现的公开命令。

### 确定修复

#### 1. 将无 Git 的示例迁移到 V2 engine

删除 `BACKEND`/`src.pipeline` 注入，并使用现有纯引擎协议：

```py
from engine.protocol import AnalyzeRequest, FileInput
from engine.runner import run_analysis

response = run_analysis(
    AnalyzeRequest(
        id="example_multi_agent",
        action="analyze",
        files=[
            FileInput(
                path="examples/demo_new.py",
                content=new,
                baseline=base,
                language="python",
            )
        ],
    )
)
if not response.ok:
    raise RuntimeError(response.error)
print(json.dumps(response.to_dict(), indent=2, ensure_ascii=False))
```

删除旧的 `agent_collaboration`、`consensus_score`、`review_queue` 输出访问，因为 V2 `AnalyzeResponse` 不提供这些 V1 字段。

#### 2. 修复仍有价值的 ablation 脚本

`evaluation/scripts/run_ablation.py` 的逻辑仍可使用，改为：

```diff
-BACKEND = PROJECT_ROOT / "backend"
-if str(BACKEND) not in sys.path:
-    sys.path.insert(0, str(BACKEND))
-from src.evaluation.ablation import DEFAULT_ABLATIONS, ablate_report
+if str(PROJECT_ROOT) not in sys.path:
+    sys.path.insert(0, str(PROJECT_ROOT))
+from engine.evaluation.ablation import DEFAULT_ABLATIONS, ablate_report
```

#### 3. 删除无法按 V2 边界运行的旧脚本

物理删除：

- `evaluation/scripts/generate_pr_report.py`
- `evaluation/scripts/run_public_pr_reports.py`

前者依赖已删除的 Python Git pipeline，后者在 Python 中 clone/fetch 并调用已删除 CLI。若未来需要批量 PR 评估，应另建调用 TypeScript context/orchestration 层的 V2 工具，不能恢复 Python 网络/Git I/O。

同步删除或改写 `evaluation/README.md`、`docs/REMOTE_ANALYSIS.md` 中对应命令。

#### 4. 给公开命令增加 CI smoke gate

CI 至少增加：

```yaml
- name: Python entrypoint smoke tests
  run: |
    python examples/multi_agent_demo.py
    python evaluation/scripts/run_ablation.py --help
```

并将 Ruff 范围扩展为：

```yaml
ruff check engine tests evaluation/scripts examples
```

---

## P0-2：`backend` 孤儿包和 V1 依赖链仍被保留

### 受影响文件

- `backend/config.py:1-67`
- `backend/requirements.txt:1-25`
- `backend/src/__init__.py:1-13`
- `requirements-dev.txt:1`
- `pyproject.toml:11-24`
- `pyproject.toml:27-44`
- `requirements-lock.txt`
- `tests/test_agents.py:8-11`
- `tests/test_multilang.py:7-10`
- `tests/test_security_evolution.py:7-10`

### 问题

`backend/config.py` 没有任何调用者，并在 import 时创建 `data/models`：

```py
DATA_DIR.mkdir(exist_ok=True)
(DATA_DIR / "models").mkdir(exist_ok=True)
```

`backend/src/__init__.py` 只说明代码已经移到 `engine`，没有兼容导出，属于空壳包。

三个测试仍把 `backend` 注入 `sys.path`，但随后只 import `engine.*`。这会制造“backend 仍被测试使用”的假象。

`requirements-dev.txt` 仍直接 include `backend/requirements.txt`，导致 CI lock 继续安装以下未被 `engine` 使用的 V1 依赖：

- `click`
- `rich`
- `GitPython`
- `astroid`
- `numpy`
- `scikit-learn`
- `requests`
- `openai`
- `python-dotenv`
- `PyYAML`

### 确定修复

1. 删除整个 tracked `backend` 兼容壳：

```text
backend/config.py
backend/requirements.txt
backend/src/__init__.py
```

2. 从上述三个测试删除：

```py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
```

3. 将 `requirements-dev.txt` 改为项目自身的 dev extra：

```text
-e .[dev]
```

4. 将 `pyproject.toml` 的运行依赖收敛为 engine 实际 import 的 tree-sitter 组件；移除未使用的 V1 运行依赖和 Python OpenAI/datasets extras：

```toml
dependencies = [
  "tree-sitter>=0.25,<0.26",
  "tree-sitter-python>=0.25,<0.26",
  "tree-sitter-javascript>=0.25,<0.26",
  "tree-sitter-typescript>=0.23,<0.24",
]
```

保留 `dev` 中确实被测试/CI 使用的 `pytest`、`pytest-cov`、`jsonschema`、`ruff`。

5. 在 Phase 7 的 Python 3.12 环境从修正后的输入重新生成 `requirements-lock.txt`，确认 lock 中不再包含上述 V1-only 依赖及其无关传递依赖。

---

## P1-1：TypeScript V1 compatibility schema/adapter 只有自身测试引用

### 受影响文件

- `apps/api/src/review/legacyReportAdapter.ts`
- `apps/api/src/review/legacyReportAdapter.test.ts`
- `packages/schema/src/legacy.ts`
- `packages/schema/src/index.ts:5`
- `packages/schema/src/index.test.ts:8-9,31-32`
- `schemas/analysis_result.schema.json`
- `schemas/pr_report.schema.json`
- `docs/output_schema.md`

### 问题

全仓引用图显示：

- `adaptLegacyReport()` 只被 `legacyReportAdapter.test.ts` 调用；
- `parseLegacyPRReport()` 只被 adapter 测试和 schema 自测调用；
- V2 Review Graph、API、Web、真实数据导入均不调用它们；
- `apps/api/src/data/realData.ts` 使用自己受限的 snapshot/report schema，不依赖 `packages/schema/src/legacy.ts`。

这是典型的“测试为了保留孤儿代码而存在”，不是生产兼容能力。

### 确定修复

物理删除：

```text
apps/api/src/review/legacyReportAdapter.ts
apps/api/src/review/legacyReportAdapter.test.ts
packages/schema/src/legacy.ts
schemas/analysis_result.schema.json
schemas/pr_report.schema.json
```

从 `packages/schema/src/index.ts` 删除：

```ts
export * from "./legacy";
```

从 `packages/schema/src/index.test.ts` 删除 legacy imports、fixture 和 legacy-only assertions。

重写 `docs/output_schema.md`，只列出 V2 的：

- `packages/schema/src/protocol.ts`
- `packages/schema/src/report.ts`
- `packages/schema/src/review.ts`
- JSON-over-stdio snake_case wire contract 与 TS camelCase domain contract

---

## P1-2：仍有无调用者的 tracked V1 数据资产

### 文件

- `data/eval/weak_eval_dataset.jsonl`
- `data/models/naming_style_model.joblib`
- `data/projects/selected_projects.json`
- `data/rules.json`

### 问题

全仓对以上四个路径和文件名的引用数均为 0。尤其 `naming_style_model.joblib` 对应的 scikit-learn 依赖仍被 lock 保留，但 V2 engine 不加载该模型。

### 确定修复

删除以上四个文件及删除后为空的目录。若某一资产必须作为长期评估数据保留，则必须同时提供：

- 明确 owner 文档；
- 可运行读取入口；
- schema 校验；
- CI smoke test。

不能以“可能以后使用”为由保留无调用者的二进制模型。

---

## P1-3：文档与 Phase 状态和实际代码不一致

### 证据

- `README.md:45-46` 仍指向已删除的 `backend/src/retrieval` 和 `backend/src/pr_report_builder.py`。
- `docs/architecture.md:6,14` 仍描述 `backend` Python CLI 与旧 PR report 流。
- `docs/PROJECT_OVERVIEW.md` 仍把 `backend` CLI 写为产品组件。
- `docs/REMOTE_ANALYSIS.md:10` 仍公开已删除的 `backend/cli.py`。
- `CONTRIBUTING.md:26` 和 PR template 仍要求执行当前会崩溃的 V1 demo。
- 主 `implementation_plan.md` 仍写 Phase 5 “REDO IN PROGRESS”、Phase 6 “PENDING”。
- `task.md` 已提前把 Phase 6 标记为 Approved。

### 确定修复

1. 在代码清理与 smoke tests 完成前，把 `task.md` 的 Phase 6 恢复为 `Redo Under Review`。
2. 清理完成后同步更新：
   - `README.md`
   - `docs/architecture.md`
   - `docs/PROJECT_OVERVIEW.md`
   - `docs/REMOTE_ANALYSIS.md`
   - `docs/output_schema.md`
   - `CONTRIBUTING.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `implementation_plan.md`
   - `task.md`
   - `walkthrough.md`
3. 文档中的 Python 路径统一为顶层 `engine`；Git clone、GitHub API、baseline fetching 统一标为 TypeScript orchestration 职责。

---

## P2：已删除 V1 源码仍以本地缓存形式存在

### 当前残留

- `backend/__pycache__/cli.cpython-311.pyc`
- `backend/src/__pycache__/pipeline.cpython-311.pyc`
- `backend/src/__pycache__/review_suggestions.cpython-311.pyc`
- 其他已删除 `backend/src` 模块的 `.pyc`
- 无 tracked 文件、无引用的顶层 `frontend/` 目录及 `frontend/__pycache__/app.cpython-311.pyc`

这些文件被 `.gitignore` 隐藏，不会出现在普通 `git status`，但与“工作区清理完成”的声明冲突，也可能误导本地排障。

### 确定修复

在确认绝对路径位于仓库后，删除：

- 整个已废弃 `backend/` 目录；
- 整个无 tracked 文件的 `frontend/` 目录；
- 项目内所有 `__pycache__`；
- `.pytest_cache`、`.ruff_cache`、`.coverage`。

不要删除 `.env`、`.consistency/` 或用户数据库，除非用户明确授权。

---

## Phase 6 必须新增的静态门禁

增加 `apps/api/src/config/cleanup.test.ts`，至少断言：

```ts
const removedPaths = [
  "backend/cli.py",
  "backend/config.py",
  "backend/requirements.txt",
  "backend/src",
  "apps/api/src/publish/publisher.ts",
  "apps/api/src/publish/dbPublisher.ts",
  "apps/api/src/github/comment.ts",
  "apps/api/src/review/legacyReportAdapter.ts",
  "packages/schema/src/legacy.ts",
  "evaluation/scripts/generate_pr_report.py",
  "evaluation/scripts/run_public_pr_reports.py"
];
```

对每一项断言 `existsSync(...) === false`。

同时扫描生产源码、测试、CI 和当前文档，拒绝：

```text
from src.
backend/cli.py
backend/src
publishPullRequestComment
publish/dbPublisher
publish/publisher
github/comment
```

审计历史 Markdown 报告可排除，因为它们需要保留历史证据。

---

## Phase 6 Redo 验收命令

```text
python examples/multi_agent_demo.py
python evaluation/scripts/run_ablation.py --help
python -m ruff check engine tests evaluation/scripts examples
python -m pytest -q
npm run typecheck
npm test
npm run build
git diff --check
```

额外静态检查：

```text
rg -n "from src\\.|backend/cli\\.py|backend/src|publishPullRequestComment|dbPublisher" \
  apps packages engine tests examples evaluation .github README.md CONTRIBUTING.md docs
```

预期结果必须为 0 个非历史引用。

完成以上整改后才可将 Phase 6 标记为 Approved，并进入 Node 22.x / Python 3.12.x 的 Phase 7 基线验收。
