# ConsistenCy Evaluation Workspace

这里是可选的公开 PR 弱标签评估脚手架。它消费 TypeScript 编排生成的 `ReviewReport` JSON，生成的 manifest、结果、本地仓库 clone 和中间数据均被忽略，以保持 GitHub 仓库轻量。

## 工作流

1. 用 `build_public_pr_manifest.py` 生成公开 PR 元数据和弱标签。
2. 将报告 JSON 放入 `evaluation/results/`。
3. 运行排序指标：

```powershell
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --output evaluation/results/metrics_summary.json
```

4. 运行信号消融：

```powershell
python evaluation/scripts/run_ablation.py --manifest evaluation/sampled_prs.json --output evaluation/results/ablation_summary.json
```

`generic_baseline` 只有在使用真正 generic baseline 重新生成报告时才是严格对照；现有报告可用于信号移除消融，因为信号分数已保存在报告中。

评估结果描述的是排序重合度。公开 Review 位置是弱标签，任何缺陷检测或安全有效性结论都需要额外的人工标注与审查。
