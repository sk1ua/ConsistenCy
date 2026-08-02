# 评估

ConsistenCy 评估的是“审查者注意力排序是否合理”，不是完美缺陷检测。评估输入是 `ReviewReport` JSON，报告生成与指标计算可以分开执行；运行步骤与目录约定见 [evaluation/README.md](../evaluation/README.md)。

## 指标

- `Precision@K` / `Recall@K`
- `Evidence Recall@K`
- `Average Compression Ratio`
- `Average Selected Evidence Count`
- `Files With Evidence`

## 边界

公开 PR Review 的文件位置是弱标签，不是缺陷金标准。`false_evidence_rate` 与 `evidence_usefulness_score` 在缺少人工标注时保持 `n/a`；任何更强的研究结论都需要独立的人工审核。

评估生成的 manifest、结果与本地仓库 clone 均被 `.gitignore` 忽略，不会进入仓库。数据集记录格式见 [dataset_schema.md](../evaluation/dataset_schema.md)。
