# ConsistenCy V2 Phase 6 Redo 验收审计报告

## 结论

**Phase 6 Redo 暂不通过。**

此前要求的物理删除基本完成：`backend/`、旧 `frontend/`、直发模块、legacy adapter/schema、V1 数据资产和两个旧 evaluation 脚本均已移除；V2 ablation import 和 CI smoke step 也已落地。

但仍存在 1 个 P0 和 3 个 P1 验收缺口。当前全绿测试没有覆盖 editable 安装失败、demo 摘要语义错误、JSON 历史数据例外和主计划状态。

---

## P0：新的 `requirements-dev.txt` 安装入口不可用

- **文件**：`requirements-dev.txt:1`
- **文件**：`pyproject.toml`
- **文档入口**：`README.md:15`、`CONTRIBUTING.md:18`

### 问题

`requirements-dev.txt` 已改为：

```text
-e .[dev]
```

但是 `pyproject.toml` 没有声明 setuptools package discovery。仓库是包含 `apps`、`engine`、`evaluation`、`packages` 等目录的 flat layout，setuptools 拒绝猜测应打包哪些目录。

### 动态证据

```text
python -m pip install --dry-run --no-deps --no-build-isolation -r requirements-dev.txt

error: Multiple top-level packages discovered in a flat-layout:
['apps', 'data', 'engine', 'output', 'schemas', 'packages', 'evaluation', 'node_modules'].
```

这不是网络问题；错误发生在本地 editable metadata 生成阶段。

### 确定修复

在 `pyproject.toml` 增加明确的 package discovery：

```toml
[tool.setuptools.packages.find]
where = ["."]
include = ["engine", "engine.*"]
exclude = ["tests", "tests.*"]
namespaces = false
```

如 setuptools 对 `include = ["engine", "engine.*"]` 的匹配行为在当前版本有差异，可使用：

```toml
[tool.setuptools]
packages = [
  "engine",
  "engine.agents",
  "engine.evaluation",
  "engine.models",
  "engine.parsers",
  "engine.retrieval",
  "engine.scoring",
]
```

优先使用 `find`，避免以后增加合法 engine 子包时漏包。

### 必须新增的 CI gate

安装依赖前，CI 本来就会通过 `requirements-lock.txt` 安装；这不能验证 `requirements-dev.txt`。增加独立 metadata/install gate：

```yaml
- name: Verify editable project metadata
  run: python -m pip install --no-deps -e .
```

Phase 6 本地验收至少执行：

```text
python -m pip install --dry-run --no-deps --no-build-isolation -r requirements-dev.txt
```

预期退出码为 0，并且输出只发现/准备安装 `consistency` 与 `engine*`，不能尝试把 `apps`、`packages`、`evaluation` 或 `node_modules` 打入 Python wheel。

---

## P1-1：V2 demo 退出 0，但摘要读取错误的数据层级

- **文件**：`examples/multi_agent_demo.py:36-42`
- **协议定义**：`engine/protocol.py:254-267`

### 问题

`AnalyzeResponse.to_dict()` 的成功结构为：

```json
{
  "id": "...",
  "ok": true,
  "files": [...],
  "consensus": {},
  "evidence_pack": null
}
```

demo 却读取不存在的顶层字段：

```py
data.get("status")
data.get("score")
data.get("risk_level")
data.get("findings")
data.get("agent_runs")
```

因此 CI smoke test 虽然退出 0，实际输出为：

```text
Status: None
Score: None
Risk Level: None
Findings Count: 0
Agent Runs Count: 0
```

同一输出后面的真实文件结果却包含 `risk_score: 0.6153`、`risk_label: "Significant Drift"` 和 findings。该示例会向用户展示错误结论。

### 确定修复

改为从 `files` 汇总：

```py
data = response.to_dict()
files = data["files"]
highest_risk = max(files, key=lambda item: item["risk_score"], default=None)
finding_count = sum(len(item["findings"]) for item in files)

print(f"Status: {'ok' if data['ok'] else 'error'}")
print(f"Files Analyzed: {len(files)}")
print(
    "Highest Risk: "
    f"{highest_risk['risk_score']:.3f} ({highest_risk['risk_label']})"
    if highest_risk
    else "Highest Risk: n/a"
)
print(f"Findings Count: {finding_count}")
```

删除 `Agent Runs Count`，因为 analyze wire response 不提供 agent runs。

### 验收

增加 Python 测试或 subprocess 测试，断言 demo 输出：

- 包含 `Status: ok`；
- 包含 `Files Analyzed: 1`；
- 不包含 `None`；
- JSON 的 `files[0].risk_score` 与摘要显示值一致。

只断言退出码 0 不足以作为 smoke gate。

---

## P1-2：静态 Cleanup gate 未扫描 JSON，遗留引用被漏过

- **文件**：`apps/api/src/config/cleanup.test.ts:34-49`
- **遗留文件**：`evaluation/smoke_manifest.json:13,36,60`

### 问题

静态扫描只包含：

```ts
/\.(ts|tsx|py|yml|yaml|md)$/
```

因此不会检查 JSON、TOML 或 requirements text。

当前 `evaluation/smoke_manifest.json` 仍包含：

```text
backend/src/remote/remote_pipeline.py
backend/src/collaboration/coordinator.py
backend/src/agents/security_agent.py
```

这些是历史 PR 标签，可能有保留价值；问题不在于必须篡改历史数据，而在于 gate 通过“完全不扫描 JSON”偶然漏过它们，并且 walkthrough 声称扫描整个 evaluation。

### 确定修复

扩展扫描类型：

```diff
-/\.(ts|tsx|py|yml|yaml|md)$/
+/\.(ts|tsx|py|yml|yaml|md|json|toml|txt)$/
```

为确属历史标签的数据建立唯一、显式的例外，不得排除全部 JSON：

```ts
const HISTORICAL_DATA_EXEMPTIONS = new Set([
  resolve(ROOT, "evaluation/smoke_manifest.json")
]);
```

在跳过该文件时写明原因：

```ts
// Historical PR labels intentionally preserve paths that existed at those commits.
```

同时增加单独测试，验证该 manifest：

- 可被 JSON parse；
- 每项具有 repo、PR number、base/head refs；
- 路径只作为 historical annotation 数据使用；
- 不被任何当前执行入口当作本地文件路径解析。

如果该 smoke manifest 已无任何消费者，则应删除，而不是添加例外。当前全仓没有发现对 `smoke_manifest.json` 的代码引用，因此推荐直接删除；只有明确记录人工 smoke 使用流程时才保留。

---

## P1-3：主计划和评估文档仍与当前状态不一致

### 主计划

`implementation_plan.md` 仍写：

```text
Phase 5 ... REDO IN PROGRESS
Phase 6 ... PENDING PHASE 5 COMPLETION
```

这与已经批准的 Phase 5、正在 Redo 验收的 Phase 6 冲突。附件没有完成上一报告要求的 master plan 同步。

### Evaluation README

`evaluation/README.md` 仍声明：

```text
2. Generate one model report JSON per PR into evaluation/results/.
```

但本轮已删除唯一两个 repo/report 生成入口：

- `evaluation/scripts/generate_pr_report.py`
- `evaluation/scripts/run_public_pr_reports.py`

当前没有文档说明应如何通过 V2 TypeScript 编排层生成这些报告。

### 确定修复

1. 更新主计划：

```text
Phase 5 — APPROVED & COMPLETE
Phase 6 — REDO UNDER REVIEW
Phase 7 — PENDING PHASE 6 APPROVAL
```

Phase 6 正式批准后再改为 `APPROVED & COMPLETE`。

2. 更新 `evaluation/README.md`，明确以下二选一：

- 提供一个真实、受测的 V2 TypeScript 报告导出命令；或
- 明确 evaluation metrics 只消费预先生成的 V2 report artifacts，当前仓库不再提供 Python Git/report generator。

不能继续写“自动生成 model reports”却不给可运行入口。

3. 修正 walkthrough 的依赖声明：

`pyproject.toml` 和 `requirements-dev.txt` 已收敛，但 `requirements-lock.txt` **尚未收敛**。lock 当前仍包含 GitPython、astroid、click、numpy、OpenAI、requests、rich、scikit-learn 等 V1 依赖。

按照既定阶段边界，可以在 Phase 7 的 Python 3.12 环境重建 lock；在此之前 walkthrough 必须明确写：

```text
Dependency input pruned; canonical requirements-lock regeneration deferred to Phase 7.
```

不能声称旧依赖已经从实际 CI 安装集合删除，因为 CI 当前仍安装旧 lock。

---

## 已确认完成的 Phase 6 项目

- `backend/` 和旧 `frontend/` 已不存在。
- 三个旧直发模块已不存在。
- legacy adapter/schema 和旧 JSON schemas 已删除。
- 四个无引用 V1 数据资产已删除。
- `generate_pr_report.py` 与 `run_public_pr_reports.py` 已删除。
- `run_ablation.py --help` 已迁移到 `engine` 并可运行。
- CI 已删除 `PYTHONPATH: backend`。
- Ruff 范围已扩展。
- 三个测试中的 backend `sys.path` 注入已删除。
- `task.md` 正确保留 `Phase 6: Redo Under Review`。

---

## Redo 验收命令

```text
python -m pip install --dry-run --no-deps --no-build-isolation -r requirements-dev.txt
python examples/multi_agent_demo.py
python evaluation/scripts/run_ablation.py --help
python -m ruff check engine tests evaluation/scripts examples
python -m pytest -q
npm run typecheck
npm test
npm run build
git diff --check
```

附加断言：

```text
demo 摘要不得出现 None
editable metadata 只发现 engine*
cleanup gate 对 JSON/TOML/TXT 的处理必须是显式扫描或显式历史例外
implementation_plan、task、walkthrough 三者状态一致
```

完成以上四项后可再次进行 Phase 6 最终验收。`requirements-lock.txt` 的 Python 3.12 正式重建仍属于 Phase 7，但必须在 Phase 6 文档中如实标记为 deferred。
