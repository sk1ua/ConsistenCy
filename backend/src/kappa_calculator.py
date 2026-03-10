# -*- coding: utf-8 -*-
"""
M5 - 标注一致性计算（Cohen's Kappa / Fleiss' Kappa）

用于：
  1. 加载多个标注员的 JSONL 标注文件
  2. 计算逐维度（style/structure/logic）和整体标签的 Kappa 系数
  3. 识别低一致性提交，生成改进指南

引用标准：
  Cohen (1960) - 双标注员二分类 Kappa
  Fleiss (1971) - 多标注员 Kappa（≥ 3 人）
  Landis & Koch (1977) - Kappa 强度阈值
"""
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).parent.parent))
import config

# Kappa 强度参考（Landis & Koch 1977）
KAPPA_THRESHOLDS = [
    (0.81, "几乎完美 (Almost Perfect)"),
    (0.61, "实质性 (Substantial)"),
    (0.41, "中等 (Moderate)"),
    (0.21, "一般 (Fair)"),
    (0.01, "轻微 (Slight)"),
    (-1.0, "随机或更差 (Poor)"),
]


def _kappa_strength(kappa: float) -> str:
    for threshold, label in KAPPA_THRESHOLDS:
        if kappa >= threshold:
            return label
    return "随机或更差 (Poor)"


# ---------------------------------------------------------------------------
# 数据加载
# ---------------------------------------------------------------------------

class AnnotationLoader:
    """加载并对齐多个标注员的 JSONL 文件"""

    def __init__(self, annotations_dir: str):
        self.annotations_dir = Path(annotations_dir)

    def load_all(self) -> Dict[str, List[Dict]]:
        """
        返回 {annotator_id: [annotation_record, ...]}
        每条记录至少含 commit_sha、style_score、structure_score、logic_score、overall_label
        """
        result: Dict[str, List[Dict]] = {}
        for jsonl_file in sorted(self.annotations_dir.glob("annotations_*.jsonl")):
            annotator_id = jsonl_file.stem.replace("annotations_", "")
            records = []
            with open(jsonl_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            if records:
                result[annotator_id] = records
                print(f"[AnnotationLoader] {annotator_id}: {len(records)} 条标注")
        return result

    def align(
        self, annotations: Dict[str, List[Dict]]
    ) -> Dict[str, Dict[str, Dict]]:
        """
        返回 {commit_sha: {annotator_id: record}}
        只保留被 **至少两个标注员** 共同标注的提交（用于 Kappa 计算）
        """
        # 构建 commit → {annotator → record}
        index: Dict[str, Dict[str, Dict]] = defaultdict(dict)
        for annotator_id, records in annotations.items():
            for rec in records:
                sha = rec.get("commit_sha", "")
                if sha:
                    index[sha][annotator_id] = rec

        # 过滤：仅保留多标注员共同标注
        aligned = {
            sha: ann_map
            for sha, ann_map in index.items()
            if len(ann_map) >= 2
        }
        print(f"[AnnotationLoader] 双标注提交: {len(aligned)} 个")
        return aligned


# ---------------------------------------------------------------------------
# Cohen's Kappa（两个标注员）
# ---------------------------------------------------------------------------

def cohen_kappa(ratings_a: List[Any], ratings_b: List[Any]) -> float:
    """
    计算两组评分的 Cohen's Kappa。

    支持任意离散类别（二分类或多分类）。
    """
    if len(ratings_a) != len(ratings_b):
        raise ValueError("两组评分长度必须相同")
    n = len(ratings_a)
    if n == 0:
        return float("nan")

    # 统一类别集合
    categories = sorted(set(ratings_a) | set(ratings_b))
    cat_idx = {c: i for i, c in enumerate(categories)}
    k = len(categories)

    # 构建混淆矩阵
    matrix = [[0] * k for _ in range(k)]
    for a, b in zip(ratings_a, ratings_b):
        matrix[cat_idx[a]][cat_idx[b]] += 1

    # P_o (observed agreement)
    p_o = sum(matrix[i][i] for i in range(k)) / n

    # P_e (expected agreement)
    row_sums = [sum(matrix[i]) / n for i in range(k)]
    col_sums = [sum(matrix[i][j] for i in range(k)) / n for j in range(k)]
    p_e = sum(row_sums[i] * col_sums[i] for i in range(k))

    if p_e == 1.0:
        return 1.0  # 完全预期一致，防止除零

    return (p_o - p_e) / (1.0 - p_e)


# ---------------------------------------------------------------------------
# Fleiss' Kappa（多标注员）
# ---------------------------------------------------------------------------

def fleiss_kappa(ratings_matrix: List[List[int]]) -> float:
    """
    计算 Fleiss' Kappa。

    Args:
        ratings_matrix: shape (N_subjects × K_categories)，
                        ratings_matrix[i][j] = 第 i 个样本被评为类别 j 的次数

    Returns:
        Fleiss' Kappa 系数
    """
    n_subjects = len(ratings_matrix)
    if n_subjects == 0:
        return float("nan")
    k_categories = len(ratings_matrix[0])
    n_raters = sum(ratings_matrix[0])  # 每个样本的评分总数（假设相同）

    if n_raters < 2:
        return float("nan")

    # P_j: 每个类别的总体比例
    total = n_subjects * n_raters
    p_j = [sum(ratings_matrix[i][j] for i in range(n_subjects)) / total
           for j in range(k_categories)]

    # P_i: 每个样本的一致性比例
    p_i_list = []
    for i in range(n_subjects):
        n_i = sum(ratings_matrix[i])
        if n_i <= 1:
            p_i_list.append(0.0)
            continue
        p_i = (sum(ratings_matrix[i][j] ** 2 for j in range(k_categories)) - n_i) / (
            n_i * (n_i - 1)
        )
        p_i_list.append(p_i)

    p_bar = sum(p_i_list) / n_subjects
    p_e = sum(pj ** 2 for pj in p_j)

    if p_e == 1.0:
        return 1.0

    return (p_bar - p_e) / (1.0 - p_e)


# ---------------------------------------------------------------------------
# 主计算器
# ---------------------------------------------------------------------------

class KappaCalculator:
    """
    计算多标注员之间的一致性系数（Cohen / Fleiss），
    并生成可操作的改进建议报告。
    """

    DIMENSIONS = ["style_score", "structure_score", "logic_score", "overall_label"]
    DIM_LABELS = {
        "style_score": "风格不一致 (Style)",
        "structure_score": "结构不一致 (Structure)",
        "logic_score": "逻辑不一致 (Logic)",
        "overall_label": "整体标签 (Overall)",
    }

    def __init__(self, annotations_dir: str):
        loader = AnnotationLoader(annotations_dir)
        raw = loader.load_all()
        self.aligned = loader.align(raw)
        self.annotator_ids = sorted(
            {aid for ann_map in self.aligned.values() for aid in ann_map}
        )
        self.n_raters = len(self.annotator_ids)

    # ---- 提取评分序列 ----

    def _extract_ratings(
        self, dimension: str
    ) -> Tuple[Dict[str, List[Any]], List[str]]:
        """
        返回 (ratings_per_annotator, common_shas)
        只包含所有标注员都标注过的提交。
        """
        common_shas = [
            sha
            for sha, ann_map in self.aligned.items()
            if all(aid in ann_map for aid in self.annotator_ids)
            and all(dimension in ann_map[aid] for aid in self.annotator_ids)
        ]
        ratings: Dict[str, List[Any]] = {
            aid: [self.aligned[sha][aid][dimension] for sha in common_shas]
            for aid in self.annotator_ids
        }
        return ratings, common_shas

    # ---- Kappa 计算 ----

    def compute_pairwise_kappa(self, dimension: str) -> Dict[str, float]:
        """
        计算所有标注员两两之间的 Cohen's Kappa。

        Returns:
            {"annotator_a vs annotator_b": kappa_value, ...}
        """
        ratings, _ = self._extract_ratings(dimension)
        pairs: Dict[str, float] = {}
        for i, a in enumerate(self.annotator_ids):
            for j, b in enumerate(self.annotator_ids):
                if j <= i:
                    continue
                k = cohen_kappa(ratings[a], ratings[b])
                pairs[f"{a} vs {b}"] = round(k, 4)
        return pairs

    def compute_average_kappa(self, dimension: str) -> float:
        """所有两两 Kappa 的均值（当标注员 ≥ 2 时有意义）"""
        pairs = self.compute_pairwise_kappa(dimension)
        if not pairs:
            return float("nan")
        return round(sum(pairs.values()) / len(pairs), 4)

    def compute_fleiss_kappa(self, dimension: str) -> float:
        """
        计算 Fleiss' Kappa（适用于 ≥ 3 个标注员；2 人时等同 Cohen's Kappa 均值）。
        """
        ratings, common_shas = self._extract_ratings(dimension)
        if not common_shas:
            return float("nan")

        all_values = sorted(
            {v for r in ratings.values() for v in r}
        )
        cat_idx = {v: i for i, v in enumerate(all_values)}
        k = len(all_values)

        # 构建 ratings_matrix (N × K)
        matrix: List[List[int]] = []
        for sha in common_shas:
            row = [0] * k
            for aid in self.annotator_ids:
                val = self.aligned[sha][aid][dimension]
                row[cat_idx[val]] += 1
            matrix.append(row)

        return round(fleiss_kappa(matrix), 4)

    # ---- 低一致性样本分析 ----

    def find_disagreements(
        self, dimension: str, threshold: int = 2
    ) -> List[Dict]:
        """
        找出标注员分歧最大的提交（各评分之间极差 ≥ threshold）。

        Returns:
            排序后的分歧列表
        """
        disagreements = []
        for sha, ann_map in self.aligned.items():
            scores = []
            for aid in self.annotator_ids:
                if aid in ann_map and dimension in ann_map[aid]:
                    scores.append(ann_map[aid][dimension])
            if len(scores) < 2:
                continue
            try:
                spread = max(scores) - min(scores)
            except TypeError:
                continue
            if spread >= threshold:
                disagreements.append({
                    "commit_sha": sha,
                    "dimension": dimension,
                    "scores": {aid: ann_map[aid].get(dimension)
                               for aid in self.annotator_ids if aid in ann_map},
                    "spread": spread,
                })
        return sorted(disagreements, key=lambda x: x["spread"], reverse=True)

    # ---- 综合报告 ----

    def generate_report(self) -> Dict:
        """生成完整的一致性检验报告"""
        report: Dict[str, Any] = {
            "annotators": self.annotator_ids,
            "n_raters": self.n_raters,
            "n_common_commits": len([
                sha for sha, m in self.aligned.items()
                if len(m) >= 2
            ]),
            "dimensions": {},
            "summary": {},
            "recommendation": "",
        }

        all_kappas = []
        for dim in self.DIMENSIONS:
            ratings, common_shas = self._extract_ratings(dim)
            n = len(common_shas)

            pairwise = self.compute_pairwise_kappa(dim)
            avg_kappa = self.compute_average_kappa(dim)
            fleiss = (self.compute_fleiss_kappa(dim)
                      if self.n_raters >= 3 else avg_kappa)
            disagreements = self.find_disagreements(dim)

            dim_result = {
                "label": self.DIM_LABELS.get(dim, dim),
                "n_common": n,
                "pairwise_kappa": pairwise,
                "average_kappa": avg_kappa,
                "fleiss_kappa": fleiss if self.n_raters >= 3 else None,
                "kappa_strength": _kappa_strength(avg_kappa),
                "passes_threshold": avg_kappa >= 0.70,
                "n_disagreements": len(disagreements),
                "top_disagreements": disagreements[:5],
            }
            report["dimensions"][dim] = dim_result
            if not (avg_kappa != avg_kappa):  # 排除 NaN
                all_kappas.append(avg_kappa)

        # 总体摘要
        if all_kappas:
            overall = sum(all_kappas) / len(all_kappas)
            report["summary"]["mean_kappa"] = round(overall, 4)
            report["summary"]["passes_threshold"] = overall >= 0.70
            report["summary"]["strength"] = _kappa_strength(overall)

            if overall >= 0.70:
                report["recommendation"] = (
                    "✅ 平均 Kappa ≥ 0.70，满足 M5 验收标准。"
                    "可进入 M6 全量标注阶段。"
                )
            elif overall >= 0.60:
                report["recommendation"] = (
                    "⚠️  平均 Kappa 在 0.60-0.70，接近目标。"
                    "建议召开标注员校准会议，重点讨论分歧列表中的提交。"
                )
            else:
                report["recommendation"] = (
                    "❌ 平均 Kappa < 0.60，需修订标注指南。"
                    "建议重新标注 pilot 批次并进行指南澄清培训。"
                )

        return report

    def save_report(
        self, report: Dict, output_path: Optional[str] = None
    ) -> Path:
        """将报告保存为 JSON 文件"""
        if output_path is None:
            out = config.DATA_DIR / "annotations" / "kappa_report.json"
        else:
            out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2, default=str)
        print(f"[KappaCalculator] 报告已保存 → {out}")
        return out

    def print_summary(self, report: Dict) -> None:
        """在终端打印简洁摘要表格"""
        print("\n" + "=" * 68)
        print("  标注一致性报告 (Inter-Rater Reliability)")
        print("=" * 68)
        print(f"  标注员: {', '.join(report['annotators'])}")
        print(f"  共同标注提交: {report['n_common_commits']}")
        print("-" * 68)
        print(f"{'维度':<28} {'Avg Kappa':>10} {'通过?':>6} {'强度'}")
        print("-" * 68)
        for dim, info in report["dimensions"].items():
            k_str = f"{info['average_kappa']:.4f}" if isinstance(
                info["average_kappa"], float) else "N/A"
            passed = "✅" if info.get("passes_threshold") else "❌"
            strength = info.get("kappa_strength", "")
            print(f"  {info['label']:<26} {k_str:>10} {passed:>6}  {strength}")
        print("=" * 68)
        summary = report.get("summary", {})
        if summary:
            print(f"  总体均值 Kappa: {summary.get('mean_kappa', 'N/A'):.4f}"
                  f"  {'✅ 通过' if summary.get('passes_threshold') else '❌ 未通过'}")
        print()
        print(f"  建议: {report.get('recommendation', '')}")
        print("=" * 68 + "\n")
