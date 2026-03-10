# ConsistenCy 开发路线图

## 当前状态

**版本**: V1 (M1-M3) 工程原型完成  
**状态**: ⚠️  评估方法学存在致命缺陷，需重构  
**目标**: V2 (M4-M9) 修复方法论问题，达到发表标准  

---

## V1 回顾 (已完成 ✅)

### M1: 基础设施
- AST 解析器和知识提取器
- 向量存储 (ChromaDB)
- CLI 工具链

### M2: 提交级分析
- Git Commit 挖掘
- 混合检索 (Vector + Graph)
- 三层风险评分 (Style/Structure/Logic)

### M3: 评估原型
⚠️ **方法缺陷** - V1 不可用于研究：
- ❌ 循环论证：标签由模型自生成
- ❌ 数据泄露：K-fold 标签依赖整个数据集
- ❌ 虚假消融：硬编码缩放因子

---

## V2 计划 (18 周)

目标：修复评估方法学问题，形成可复现实验流程。

### Phase 1: 人工标注 (Week 1-10)

#### M4: 标注准备 (Week 1-2)
- [x] 编写标注指南 → `data/annotations/ANNOTATION_GUIDELINE.md`
- [x] 构建标注工具 → `backend/src/annotation_tool.py`
- [x] 构建项目选择器 → `backend/src/project_selector.py`
- [x] 构建提交采样器 → `backend/src/project_selector.py::CommitSampler`
- [x] 预选 10 个项目 → `data/projects/selected_projects.json`
- [x] CLI 流水线 → `python cli.py m4 select-projects / sample-commits / annotate`
- [ ] 招募 2-3 名标注员（人工环节）

#### M5: Pilot 标注 (Week 3-4)
- [ ] 标注 50 pilot 样本（使用 `python cli.py m4 annotate`）
- [x] Cohen's Kappa 计算器 → `backend/src/kappa_calculator.py`
- [x] CLI 验收命令 → `python cli.py m4 calc-kappa <annotations_dir>`
- [ ] 执行 Pilot：Kappa ≥ 0.70
- [ ] 迭代优化指南

产出：小规模高一致性标注集与标注流程基线。

#### M6: 全量标注 (Week 5-10)
- [ ] 标注 500+ 样本
- [ ] 跨项目数据集

产出：可用于训练与独立评估的标注数据集。

### Phase 2: 评估重构 (Week 11-13)

#### M7: 新框架实现
- [x] `HumanLabeledEvaluator` - 消除循环论证 → `backend/src/human_labeled_evaluator.py`
- [x] `AblationStudyV2` - 真实消融 → `backend/src/ablation_study_v2.py`
- [x] 基线对比 + 显著性检验 → `backend/src/baselines.py`
- [x] 跨项目评估 → `backend/src/cross_project_evaluator.py`
- [x] CLI 命令 → `eval-human / ablation-v2 / compare-baselines-v2 / dataset-stats`

产出：独立测试集评估报告与可复现实验脚本。

### Phase 3: 跨项目评估 (Week 14-16)

#### M8: 泛化测试
- [ ] Zero-shot 评估
- [ ] Few-shot 评估
- [ ] F1 降幅 < 20%

产出：跨项目泛化能力结论与失败案例分析。

### Phase 4: 论文撰写 (Week 17-18)

#### M9: 发表准备
- [ ] 整理实验结果
- [ ] 撰写论文 (ICSE/ASE/FSE)
- [ ] 开源数据集和代码

产出：可投稿版本论文与公开复现实验包。

---

## MVP 验收标准

| 指标 | 目标 | 状态 |
|------|------|------|
| 标注样本 | ≥ 500 | 🔄 0（M4 工具已就绪）|
| Kappa | ≥ 0.70 | 🔄 待执行（计算器已就绪）|
| Test F1 | ≥ 0.65 | ⏳ 待评估 |
| 优于基线 | p < 0.05 | ⏳ 待对比 |
| 跨项目降幅 | < 20% | ⏳ 待测试 |

---

## 参考文档

| 文档 | 路径 |
|------|------|
| 项目说明 | [README.md](README.md) |
| 系统架构 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 标注指南 | [data/annotations/ANNOTATION_GUIDELINE.md](data/annotations/ANNOTATION_GUIDELINE.md) |

---

**最后更新**: 2026-03-10
