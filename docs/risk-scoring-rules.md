# 风险评分与严重性规则定义（risk-rules）

| 字段 | 值 |
| --- | --- |
| 规则版本号 | `risk-rules/v3.1`（上一版 `risk-rules/v3.0`） |
| 定义日期 | 2026-09-27 |
| 代码基线 | 分支 `v3`，HEAD `0b20fa2` |
| 单一规则表实现 | `engine/models/enums.py` |
| TS 侧镜像 | `packages/schema/src/report.ts`（`CANONICAL_RISK_BAND_THRESHOLDS`） |
| 评估集 | `engine/evaluation/scoring_cases.json`（`scoring-set/v1`） |
| 评估执行器 | `engine/evaluation/scoring_eval.py` |
| 回归测试 | `tests/test_scoring_rules.py` |
| 跨语言漂移检测 | `tests/test_scoring_rule_parity.py` |

## 0. 本文件的性质与证据分层

本文件是**规则定义**（rule specification）：它规定分数如何由分子/分母/权重/阈值/取整计算出来，并规定规则版本如何演进。

本文件**不是模型质量校准结论**。评估集规模很小，只能证明规则在固定样本上的单调性与阈值行为，不能证明真实项目上的误报/漏报水平。任何"已校准"的表述都超出了本文件的证据范围。

证据分层：

- **实现**：`engine/models/enums.py` 是唯一规则表；`engine/scoring/composer.py`、`engine/analyzer*`、`engine/runner.py`、`engine/workflow/builtins.py` 只从该表取值，不保留字面量。
- **接入**：`run_analysis`（逐文件风险）与 `compose_review`（变更集风险）两条路径都走同一张表。
- **测试**：`tests/test_scoring_rules.py` 钉住不变式与新旧规则差异；`tests/test_engine_protocol.py` 钉住 JSON-over-stdio 协议。
- **实测**：`engine/evaluation/scoring_eval.py` 在固定数据集上打印误报/漏报/覆盖率表格，数字由执行产生。

## 1. 记号与取值域

- `S_style, S_struct, S_sem, S_dup, S_sec ∈ [0, 1]`：五个确定性信号分（见 §2）。
- `R_f ∈ [0, 1]`：单文件风险（file risk）。
- `r_det ∈ [0, 1]`：变更集确定性风险。
- `r_final ∈ [0, 1]`：叠加模型发现下界后的最终变更集风险。
- `overall_score ∈ {0, 1, …, 100}`：面向用户的总分，`overall_score = round((1 − r_final) × 100)`。
- 所有比较使用 `≥`（含左端点），即风险带是**左闭右开**区间。
- 所有信号分在离开分析器前由 `AnalyzerBase.clamp` 夹到 `[0, 1]`。

## 2. 信号分的分子与分母

分式一律写成 `分子 / 分母`，并给出饱和上限。

### 2.1 style（`engine/analyzers/style_analyzer.py`）

```
S_style = clamp(0.40·naming + 0.25·doc + 0.20·format + 0.15·comment)
naming  = 1 − cos(特征向量_now, 特征向量_base)     分母：向量模长乘积
doc     = |docstring_ratio_now − docstring_ratio_base|   分母：函数+类总数
format  = 1 − cos((mean/120, p95/120)_now, …_base)  分母：向量模长乘积、行长归一化 120
comment = clamp(|cmt_now − cmt_base| × 4)           分母：code_lines + 1，缩放 4
```

自权重和 `0.40 + 0.25 + 0.20 + 0.15 = 1.00`。

### 2.2 structural（`engine/analyzers/structural_analyzer.py`）

```
S_struct = clamp(0.30·import_drift + 0.25·coupling_drift
                 + 0.20·depth_drift + 0.25·complexity_drift)
import_drift     = 1 − |I_now ∩ I_base| / |I_now ∪ I_base|   分母：导入集合并集大小
coupling_drift   = |fan_out_now − fan_out_base| / max(fan_out_base, 1)   分母：基线 fan-out
depth_drift      = |avg_depth_now − avg_depth_base| / max(avg_depth_base, 1)  分母：基线平均继承深度
complexity_drift = |cc_now − cc_base| / max(cc_base, 1)      分母：基线平均圈复杂度
```

自权重和 `1.00`。空分母一律取 `1`（`safe_div` / `max(...,1)`），即"基线为空"不产生除零，也不放大分数。

### 2.3 semantic（`engine/analyzers/semantic_analyzer.py`）

```
S_sem = clamp(0.45·ast + 0.30·api + 0.25·cf)
ast = 1 − |FP_now ∩ FP_base| / |FP_now ∪ FP_base|   分母：AST 子树指纹集合并集大小
api = 1 − |A_now ∩ A_base| / |A_now ∪ A_base|       分母：被调用名集合并集大小
cf  = min(2 × Σ_k |p_now(k) − p_base(k)| / |K|, 1)  分母：控制流节点类别数 |K|，再乘 2 饱和
```

自权重和 `1.00`。`ast` 是子树指纹 Jaccard 距离，是 tree-edit distance 的 O(n) 近似，不是形式化语义等价判定。

### 2.4 duplication（`engine/analyzers/duplication_analyzer.py`）

```
dup_fraction = min(duplicated_tokens / max(5 × non_blank_lines, 1), 1)
S_dup        = clamp(dup_fraction / 0.20)
```

- 分子：主文件中**参与** ≥80% token 相似克隆对的函数所覆盖的规范化 token 数。
- 分母：`5 × 非空行数`（经验值 ~5 token/行）；等价地，`S_dup` 的有效分母是 `0.20 × 5 × LOC`。
- 少于 2 个函数时 `S_dup = 0.0`（证据串为 "Too few functions"）。

### 2.5 security（`engine/analyzers/security_analyzer.py`）

```
S_sec = min(Σ_i w(severity_i), 1.0) / 1.0       分母：饱和值 1.0（不做样本数归一化）
w(CRITICAL) = 0.60, w(HIGH) = 0.30, w(MEDIUM) = 0.12, w(LOW) = 0.05
```

- 求和对象是**去重后**的发现（去重键 `(line, category, description[:40])`）。
- **分母不随文件长度增长**：安全分是"当前状态的有界绝对量"，不是密度。有意为之：同一份代码被放进更大的文件不改变其安全风险。
- 单条 CRITICAL 即 0.60，已足够触发 §4.3 的单文件 RED 硬闸。

## 3. 单文件风险 `R_f`

```
base          = 0.28·S_style + 0.39·S_struct + 0.33·S_sem          (权重和 = 1.00)
dup_boost     = 0.05 × min(S_dup / 0.30, 1.0)    若 S_dup > 0.05，否则 0.0
security_boost= 0.50 × S_sec
R_raw         = clamp(base + dup_boost + security_boost)          分母：1.0（有界绝对量表）
R_f           = round_half_even(R_raw, 4)
```

单文件 security 硬闸（`risk-rules/v3.1` 与 `v3.0` 相同）：

```
若 S_sec ≥ 0.60 则 R_f ≥ 0.75   (1 条 CRITICAL)
若 S_sec ≥ 0.30 则 R_f ≥ 0.50   (1 条 HIGH)
```

闸门阈值与 `w(CRITICAL)=0.60`、`w(HIGH)=0.30` **同源**：它们不是独立常数，而是"一条 CRITICAL / 一条 HIGH 恰好达到闸门"。`dup_boost` 在 `S_dup` 略大于 0.05 时从 0 跳到 ≈0.0083，这是一个**有意的触发式下界**，不是连续函数，属于已知不连续点（见 §6.3）。

## 4. 变更集聚合 `r_det` / `r_final`

记变更集文件风险 `{R_1 … R_n}`，`mean_risk = (Σ R_i)/n`，`max_risk = max_i R_i`。

### 4.1 凸组合

```
若 n > 1 : r_conv = 0.70·mean_risk + 0.30·max_risk
若 n = 1 : r_det  = max_risk        （单文件不做混合）
```

`0.70 + 0.30 = 1.00`，且 `r_conv ∈ [mean_risk, max_risk]`，因此 `r_conv ≤ max_risk` 恒成立。

### 4.2 确定性硬闸（`risk-rules/v3.1` 的唯一数值变更点）

```
findings_lower = 全部文件 findings 串转小写
has_det_critical = (max_risk ≥ 0.75) 或 任一 finding 含 "[critical]"
has_det_high     = (max_risk ≥ 0.50) 或 任一 finding 含 "[high]"

若 has_det_critical : r_det = max(r_conv, 0.75)
否则若 has_det_high : r_det = max(r_conv, 0.50)
否则                : r_det = r_conv
```

`0.75` 与 `0.50` **只能**由 `engine/models/enums.py` 导出（`critical_threshold()` / `high_threshold()`），调用方不得写字面量。

### 4.3 模型发现覆盖层（单调不增风险的补丁，只抬高不降低）

```
任一 finding 含 "[critical/" → r_final ≥ 0.75
否则 任一含 "[high/"        → r_final ≥ 0.50
否则 任一含 "[medium/"      → r_final ≥ 0.25
否则 任一含 "[low/"         → r_final ≥ 0.10
```

前缀带斜杠（`[critical/`）是模型发现的形状，与确定性证据的 `[CRITICAL] …` / `[RED] …` 形状不同，两条通道不会互相误触。模型通道只取最高一档（`elif` 链），且只使用 `max`，永远不会把 `r_det` 调低。

```
r_final = clamp(max(r_det, 模型下界))
overall_score = round_half_even((1 − r_final) × 100)
```

## 5. 阈值表与严重性映射

`engine/models/enums.py:RISK_BANDS`（唯一来源，按 `min_score` 降序匹配）：

| `min_score` | label | colour | 机器等级 | 区间 |
| --- | --- | --- | --- | --- |
| 0.75 | High Risk | RED | critical | `[0.75, 1.00]` |
| 0.50 | Significant Drift | ORANGE | high | `[0.50, 0.75)` |
| 0.25 | Minor Drift | YELLOW | medium | `[0.25, 0.50)` |
| 0.00 | Consistent | GREEN | low | `[0.00, 0.25)` |

- `_RISK_THRESHOLDS` 保留为 `(min_score, label, colour)` 三元组视图，形状不变，供既有调用方使用。
- 严重性字（CRITICAL/HIGH/MEDIUM/LOW）是**发现级**标签；上表的机器等级是**文件/变更集级**标签。二者的桥接只在两处：`SEVERITY_WEIGHTS`（§2.5）与 `engine/workflow/builtins.py` 的 `severity_for_score`（下同表，`score < 0.25 → "info"`）。

`engine/workflow/builtins.py`：

```
score ≥ 0.75 → "high"
score ≥ 0.50 → "medium"
score ≥ 0.25 → "low"
否则         → "info"
```

该映射使用同一组端点（0.75/0.50/0.25），但**命名空间不同**：工作流证据项的 `severity` 词汇表是 `{high, medium, low, info}`，不等于发现级词汇表，也不等于机器等级词汇表。不要跨词汇表比较字符串。

## 6. 单调性声明（弱单调 vs 严格单调）

本节把两类性质分开声明。**弱单调（单调不增/不减）**指 `x ≤ y ⇒ f(x) ≤ f(y)`；**严格单调**指 `x < y ⇒ f(x) < f(y)`。二者不可互相替代：多条性质在饱和点或平台区退化为弱单调。

### 6.1 成立的性质（弱，附条件）

| 编号 | 命题 | 条件 |
| --- | --- | --- |
| W1 | `R_f` 对每个 `S_i` 单调不减 | 权重 ≥ 0；`R_raw < 1.0` 时严格，`= 1.0` 时退化为平台 |
| W2 | `r_conv` 对每个 `R_i` 单调不减 | 文件集合固定 |
| W3 | `r_det` 对每个 `R_i` 单调不减 | 文件集合固定；闸门是 `max`，不会反向 |
| W4 | `r_final` 对 `r_det` 与模型下界单调不减 | `max` + `clamp` |
| W5 | `overall_score` 对 `r_final` 单调不增 | 仿射变换 `100(1−r)` |
| W6 | `RISK_BANDS` 的等级对分数单调不减 | 按 `min_score` 降序首命中 |

### 6.2 不成立的性质（必须显式承认）

| 编号 | 反面命题 | 反例 |
| --- | --- | --- |
| N1 | `r_det` **不**对文件集合包含关系单调 | 加入清洁文件会拉低 `mean_risk`，凸组合随之下降 |
| N2 | `R_f` **不**对文件长度单调 | §2.5 分母不随行数增长；安全发现数与行数无关 |
| N3 | `dup_boost` **不**连续 | `S_dup = 0.05` 时 0.0，`S_dup = 0.0501` 时 ≈0.00835 |

N1 是 §7 硬闸存在的唯一理由：闸门用 `max` 把"关键/高危档"从集合包含的稀释中救回来，**中低档（YELLOW/GREEN）有意不做闸门**（它们只是提示，不是阻断信号）。因此：**变更集等级不低于最高单文件档，仅在 RED/ORANGE 两档成立**。

### 6.3 `v3.0 → v3.1` 的单调性类别

`v3.1` 只改 §4.2 的两个端点：确定性 critical 闸从 `0.80` 降到 `0.75`，high 闸从 `0.60` 降到 `0.50`。这两处都使用 `max`，因此：

- **critical 集合是单调扩张（单调不减，`crit(v3.1) ⊇ crit(v3.0)`），不是严格扩张。**
- 扩张严格（真超集）当且仅当存在变更集的 `max_risk ∈ [0.75, 0.80)` 且无 `[critical]` 文本；high 档同理对应 `[0.50, 0.60)`。
- 不存在任何输入使 `v3.1` 的等级**低于** `v3.0`（两处 `max` 的下界都变低或不变，档位函数对分数单调），即"不变差、只更灵敏"。

边界判定（`findings` 中无 `[critical]` / `[high]` 文本，且加入足量清洁文件使 `r_conv → 0`；此时 `r_det` 等于下表中的闸门下界）：

| `max_risk` | `v3.0` 命中分支 | `v3.0` 下界 | `v3.1` 命中分支 | `v3.1` 下界 | `v3.0` 等级 | `v3.1` 等级 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.7499 | high 闸（≥0.60） | 0.50 | high 闸（≥0.50） | 0.50 | high | high |
| 0.7500 | high 闸（≥0.60） | 0.50 | critical 闸（≥0.75） | 0.75 | high | critical |
| 0.7501 | high 闸（≥0.60） | 0.50 | critical 闸（≥0.75） | 0.75 | high | critical |
| 0.5999 | 无闸命中 | `r_conv` | high 闸（≥0.50） | 0.50 | low | high |
| 0.5000 | 无闸命中 | `r_conv` | high 闸（≥0.50） | 0.50 | low | high |

`0.7499 / 0.7500 / 0.7501` 三点的判定由 `tests/test_scoring_rules.py::test_hard_gate_boundary_three_points` 实测钉住。

## 7. 硬闸语义（不变式）

**不变式 G1（critical 不可稀释）**：若变更集内存在单文件风险 `≥ critical_threshold()`，则无论再加入多少清洁文件，`r_final ≥ 0.75`，`risk_level = "critical"`。
证明：`has_det_critical` 由 `max_risk` 判定，与 `n` 无关；`r_det = max(r_conv, 0.75) ≥ 0.75`；模型层只用 `max`。∎

**不变式 G2（high 不可稀释）**：同理，`max_risk ≥ high_threshold()` ⇒ `r_final ≥ 0.50`，`risk_level ∈ {high, critical}`。

**不变式 G3（模型不降级）**：模型通道仅取 `max`，不存在任何模型输入使 `r_final < r_det`。

**已知限度**：G1/G2 只覆盖 RED/ORANGE 两档；单文件落在 YELLOW 档（`[0.25, 0.50)`）时变更集仍可被大量清洁文件稀释到 `low`。这是设计选择，不是缺陷；若未来需要，应由产品决策显式升版（见 §8）。

## 8. 版本号与版本策略

- 规则版本号形如 `risk-rules/vMAJOR.MINOR`，常量位于 `engine/models/enums.py:RULE_VERSION`。
- **MINOR 升版**（`v3.1 → v3.2`）：任何会改变既有分数、等级或闸门判定的改动（数值、阈值、权重、闸门触发条件、取整方式）。必须同时：更新本文件、更新评估集基线、在 `docs/` 记录变更前后的评估数字。
- **补丁级说明**（不升 MINOR）：纯重构、注释、文档、类型标注、变量改名，前提是同数据集上新旧实现的分数逐字节一致（由评估脚本的对比表证明）。
- **不兼容升版**（MAJOR）：改变字段语义或取值域（例如把 `risk_score` 从 `[0,1]` 改为百分制）。必须同步 JSON-over-stdio 协议与 TS schema。
- 报告面必须带上命中的规则版本号：`RiskScoringAnalyzer.aggregate` 的 `details.rule_version`，以及评估脚本输出表头。
- 历史 `report_json` 不做回溯改写；版本号用于区分"当时用的哪套规则"。

## 9. 取整策略

| 对象 | 策略 | 理由 |
| --- | --- | --- |
| `R_f` | `round(x, 4)`（half-even，二进制浮点上等于四舍六入五成双） | 稳定序列化、可比对；4 位足够区分 `0.7499/0.7500` |
| `S_style/S_struct/S_sem` | 不取整（内存中保留双精度） | 只在展示层格式化 |
| `S_sec` | 不取整（权重是 2 位小数，浮点求和可精确表示） | 与权重同量级，无累积误差 |
| `overall_score` | `round((1 − r_final) × 100)`，整数 | 面向用户；**先定档再取整**，档位判定用未取整的 `r_final` |
| 等级判定 | 取整前 | 避免"整数分与等级互相矛盾" |

注意：`overall_score` 是 `r_final` 的**投影**，不是另一个真值来源。任何下游若只用 `overall_score` 反推等级，必须使用与 `RISK_BANDS` 相同的端点，否则会产生跨实现分歧（§10.2）。

## 10. 已知分歧与边界

### 10.1 中低档无闸（有意）

见 §6.2/§7：`[0.25, 0.50)` 单文件在大量清洁文件加入后仍会被稀释。`risk-rules/v3.1` 不改变该行为。

### 10.2 TS 侧 `riskLevelForScore`：已对齐 canonical（含跨语言漂移检测）

历史问题（`risk-rules/v3.1` 之前）：`packages/schema/src/report.ts` 的 `riskLevelForScore(overall_score)` 使用 `≤39 → critical`、`≤59 → high`、`≤79 → medium`，等价于 `r ≥ 0.61 / 0.41 / 0.21`，与 Python `compose_review` 的 `r ≥ 0.75 / 0.50 / 0.25`（即 `overall_score ≤ 25 / 50 / 75`）不一致：

| `overall_score` | Python 等级（`r`） | 旧 TS 等级（`r`） | 是否分歧 |
| --- | --- | --- | --- |
| 100 / 90 | low | low | 否 |
| 79 | low (0.21) | medium (0.21) | **是** |
| 60 | medium (0.40) | high (0.40) | **是** |
| 50 | high (0.50) | high (0.50) | 否 |
| 35 | high (0.65) | critical (0.65) | **是** |
| 25 | critical (0.75) | critical (0.75) | 否 |

现行实现（`risk-rules/v3.1` 起）：

```ts
export const CANONICAL_RISK_BAND_THRESHOLDS = { critical: 0.75, high: 0.5, medium: 0.25 } as const;
export const CANONICAL_OVERALL_SCORE_BOUNDS = {
  critical: 100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.critical),  // 25
  high:     100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.high),      // 50
  medium:   100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.medium)     // 75
} as const;
```

**防漂移**：`tests/test_scoring_rule_parity.py` 用正则解析 `report.ts` 的阈值块、`100 * (1 - …)` 派生块与 `riskLevelForScore` 的三个比较分支（含顺序与 `<=` 运算符），再模拟该函数对 `overall_score ∈ {0,25,26,39,40,50,51,59,60,75,76,79,80,100}` 的判定，并与 Python `score_to_machine_level((100 − score)/100)` 逐一比对；**解析失败即 fail（不 skip、不 pass）**。TS 侧同一张边界表在 `packages/schema/src/index.test.ts`（"maps quality scores to risk levels using the canonical engine bands"）中枚举。该测试已在人为把 TS 阈值改成 `0.7` 时变红（3 failed，报错 `overall_score=26: TS says critical, canonical Python band says high`），改回后复绿。

### 10.3 不同量纲 / 不同用途的分数（登记，不参与 canonical 判定）

- `packages/schema/src/audit.ts:49` 的 `riskScoreSchema` 是 `[0, 100]` 量纲，默认 `warnAtRiskScore = 40` / `failAtRiskScore = 70`（等价 `r = 0.40 / 0.70`，可配置）。它是审计策略层阈值，与引擎 `[0, 1]` 风险分**不同量纲**，不得直接与 `RISK_BANDS` 比较，也不随本规则表变动。
- `packages/workload-review/src/supervisor/supervisor.ts:101` 用 `riskScore >= 0.5` 筛 high-risk 文件，与 canonical ORANGE 下界一致（无分歧）。
- `engine/runner.py` 中 `analyze_sources` 的 legacy 决策词见 §10.5。

### 10.4 发现级与文件级词汇不通用

见 §5 的桥接说明。禁止把 `"[MEDIUM]"` 证据串与 `"medium"` 机器等级当作同一枚举。

### 10.5 旧兼容投影 `analyze_sources`（legacy，非 canonical）

`engine/runner.py` 的 `analyze_sources` 为旧嵌入方保留 `agent_collaboration.decision`：

```
risk_score < 0.3 → approve
risk_score < 0.6 → request_changes
否则             → block_merge
```

- 这是 **legacy 兼容投影**，端点 `0.3 / 0.6` 与 canonical（`risk-rules/v3.1` 的 `0.25 / 0.50 / 0.75`）**不同源**，并且它早于规则版本号机制，本身不带版本号。
- **新消费者不得使用该字段做等级判定**；应使用 `risk_score` + 本文件的 `RISK_BANDS`（或引擎返回的 `risk_level`）。
- 同一 run 里 legacy 投影与 canonical `risk_level` 可能给出不同口径（例：`risk_score = 0.75` → legacy `block_merge`，canonical `critical`；`risk_score = 0.405` → legacy `request_changes`，canonical `medium`）。这是已知的**口径分裂**：本次只登记 + 用测试钉住现状（`tests/test_scoring_rules.py::test_legacy_analyze_sources_projection_is_pinned`），**未修**，对齐需另行升版决策。

## 11. 评估协议（规则行为评估，非模型质量评估）

- **数据集**：`engine/evaluation/scoring_cases.json`。每个样本带 `source_path`（仓库内真实路径）、`source_lines`、`slice_sha256`（钉住内容）、`kind ∈ {real_file, real_fragment, derived_real}`、`human_risk_label`（人工判定等级）与 `rationale`（判定理由）。派生样本必须写明机械变换，不得手写伪造数据。
- **执行器**：`engine/evaluation/scoring_eval.py`。逐样本调用真实 `run_analysis` 得到 `R_f`，再分别用 `v3.0` 冻结表与 `v3.1` 活动表对同一批分数做变更集聚合，打印表格（含规则版本、分母、命中样本数）。
- **指标定义**（阈值点 `T = high_threshold() = 0.50`，二分类"需要关注"）：
  - 正类 = `human_risk_label ∈ {high, critical}`；预测正类 = 规则等级 `∈ {high, critical}`。
  - `TP/FP/FN/TN` 按变更集计数；`precision = TP/(TP+FP)`，`recall = TP/(TP+FN)`，`F1 = 2PR/(P+R)`。
  - `coverage = 有效样本数 / 数据集样本数`（解析失败、分析异常等计入分母但不计入预测）。
  - 另给出严格 critical 口径（正类 = `critical`）与"被判 critical 的文件数/变更集数"。
- **证据边界**：本数据集是**小样本人工标注集**（规模见评估表头），只能证明规则在固定样本上的单调性、阈值行为与新旧差异方向，**不能**证明真实项目上的误报/漏报率，也不能作为模型质量结论。

### 11.1 实测结果（由 `scoring_eval.py` 执行产出，非手写）

命令：

```
.\.venv\Scripts\python.exe -m engine.evaluation.scoring_eval
```

数据集分母：48 个样本（`real_file` 40 / `real_fragment` 5 / `derived_real` 3，其中清洁池 36）、12 个变更集。文件级新旧实现最大差值 `max |R_f(v3.0) − R_f(v3.1)| = 0.000000`（0 处不一致）。

"需要关注"口径（人工 `≥ high` 为正类）：

| 指标 | `v3.0`（冻结） | `v3.1`（现行） | 差值 |
| --- | --- | --- | --- |
| TP | 5 | 7 | +2 |
| FP | 3 | 3 | 0 |
| FN | 2 | 0 | −2 |
| TN | 2 | 2 | 0 |
| precision | 0.625 | 0.700 | +0.075 |
| recall | 0.714 | 1.000 | +0.286 |
| F1 | 0.667 | 0.824 | +0.157 |
| coverage | 1.000 | 1.000 | 0 |

严格 critical 口径：`v3.0` 预测 1 个 critical（TP 1 / FN 2），`v3.1` 预测 6 个（TP 3 / FP 3 / FN 0）。新增的 3 个误报全部来自同一根因：**凭据形状的测试 fixture**（`ghp_…` 与 `-----BEGIN PRIVATE KEY-----`）在文件级就被判 RED，硬闸对齐后不再被清洁文件稀释，于是等级从 `high` 变为 `critical`。也就是说，`v3.1` 没有增加误报**数量**，但把已知误报的**严重度**抬到了与文件自身档位一致的水平；根因在凭据正则无法区分 fixture 与活凭据，属后续单独议题。

文件级（48 个样本）：TP 2 / FP 2 / FN 0 / TN 44，precision 0.500、recall 1.000；两个误报同为上述凭据 fixture，另有两个真实文件（`engine/knowledge/indexer.py` 的参数化查询、`engine/workflow/builtins.py` 的 `select` 文案与语法检查 `compile`）只在**发现级**误报，档位仍为 `Consistent`。

## 12. 变更记录

| 版本 | 变更 |
| --- | --- |
| `v3.0` | 隐式定义：`enums.py` 阈值 0.75/0.50/0.25；`runner.py` 硬编码 critical 闸 0.80、high 闸 0.60；`composer.py` 权重与 security 闸 0.60/0.30；TS `riskLevelForScore` 端点 39/59/79。 |
| `v3.1` | 规则集中到 `engine/models/enums.py` 单一表并显式声明分子/分母/取整/单调性；确定性 hard gate 端点对齐 canonical 档位端点（critical `0.80 → 0.75`，high `0.60 → 0.50`）；`runner.py` 去除闸门字面量；TS `riskLevelForScore` 对齐 canonical 并加跨语言漂移检测；新增固定数据集、评估脚本与不变式测试。 |

## 13. 相关文件

- [architecture.md](architecture.md)：引擎与信号总体结构。
- [EVALUATION.md](EVALUATION.md)：评估方法学。
- [output_schema.md](output_schema.md)：报告字段。
- `engine/models/enums.py`：唯一规则表。
- `engine/evaluation/scoring_cases.json`：固定评估集（`scoring-set/v1`）。`base_commit` 为 `0b20fa2`（采样起点），但 pin（`file_sha256_at_pin` / `slice_sha256`）记录的是 **2026-09-27 重建时刻工作树**的内容（基线提交 + 当日未提交改动），因此部分样本与 `0b20fa2` 的提交内容并不逐字节相同；校验一律以该文件的 `pin_basis` 字段与记录的哈希为准。
- `engine/evaluation/build_scoring_cases.py`：评估集构建脚本（真实文件/片段 + 来源哈希）。
- `engine/evaluation/scoring_eval.py`：新旧规则对比执行器。
- `tests/test_scoring_rules.py`：不变式、边界与数据集断言。
- `tests/test_scoring_rule_parity.py`：Python ↔ TS 规则漂移检测。
