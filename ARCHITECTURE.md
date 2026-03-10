# ConsistenCy 系统架构

## 目标

ConsistenCy 以 commit 为分析单元评估代码一致性风险，输出可解释证据，支持代码评审与长期治理。

核心目标：

1. 检测三类漂移：风格、结构、逻辑。
2. 输出可追溯证据：相似代码与命中规则。
3. 兼顾工程落地与研究扩展。

---

## 总体设计

```text
User / CI
  │
  ▼
CLI
  │
  ├── Scan Pipeline
  │     ├── Parser (AST)
  │     ├── Extractor
  │     └── Storage (Vector DB)
  │
  └── Commit Pipeline
        ├── Commit Miner (Git)
        ├── Retriever (Vector + Graph)
        ├── Risk Scorer
        └── Evidence Report
```

---

## 组件说明

| 组件 | 职责 | 实现位置 |
| --- | --- | --- |
| CLI | 扫描、分析、评估入口 | `backend/cli.py` |
| Parser | 解析 Python 源码到 AST | `backend/src/parser.py` |
| Extractor | 抽取函数/类/命名特征 | `backend/src/extractor.py` |
| Storage | 存储与检索语义向量 | `backend/src/storage.py` |
| Commit Miner | 构建提交上下文（diff、作者、文件） | `backend/src/commit_pipeline.py` |
| Retriever | 融合向量证据与图谱证据 | `backend/src/commit_pipeline.py` |
| Risk Scorer | 计算 style/structure/logic 风险 | `backend/src/commit_pipeline.py` |

---

## 风险模型

系统输出三维风险：

1. `style_risk`：命名风格和规范偏离。
2. `structure_risk`：函数规模和结构复杂度偏离。
3. `logic_risk`：与历史实现模式的语义偏离。

默认融合公式：

$$
overall\_risk = 0.4 \times style + 0.3 \times structure + 0.3 \times logic
$$

权重可在 `backend/config.py` 调整。

---

## 核心数据流

### 1) Scan 阶段

1. 扫描目标仓库中的 Python 文件。
2. 进行 AST 解析和结构化特征提取。
3. 写入向量知识库。

### 2) Commit 分析阶段

1. 挖掘 commit 变更上下文。
2. 检索相似实现（向量 + 可选图谱）。
3. 输出风险分和可解释证据。

### 3) Evaluation 阶段

1. 在评估集上验证检测能力。
2. 输出 Precision、Recall、F1、Accuracy。

说明：V1 中的弱监督评估仅用于工程验证，不建议作为研究结论。

---

## 扩展方向

1. 检索层：引入 rerank、规则增强和更强融合策略。
2. 数据层：从单项目扩展到跨项目评估。
3. 模型层：从轻量模型升级到更强语义模型。
4. 工程层：集成 CI、PR 报告和团队基线治理。
