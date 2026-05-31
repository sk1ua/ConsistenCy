"""Metrics for ranking alignment and reviewer agreement."""

from __future__ import annotations

from collections import Counter
from math import sqrt
from typing import Sequence


def top_k_hit_rate(predicted: Sequence[str], annotated: Sequence[str], k: int = 3) -> float:
    """Fraction of annotated risky files present in the model top-k."""

    if not annotated:
        return 0.0
    pred = set(predicted[:k])
    gold = set(annotated)
    return len(pred & gold) / len(gold)


def precision_at_k(predicted: Sequence[str], annotated: Sequence[str], k: int = 3) -> float:
    """Precision of model top-k files against annotated risky files."""

    if k <= 0:
        return 0.0
    pred = list(predicted[:k])
    if not pred:
        return 0.0
    gold = set(annotated)
    return len(set(pred) & gold) / len(pred)


def recall_at_k(predicted: Sequence[str], annotated: Sequence[str], k: int = 3) -> float:
    """Recall of annotated risky files covered by model top-k."""

    return top_k_hit_rate(predicted, annotated, k=k)


def spearman_rank_correlation(predicted_scores: Sequence[float], gold_scores: Sequence[float]) -> float:
    """Compute Spearman correlation for two equally sized score lists."""

    if len(predicted_scores) != len(gold_scores) or len(predicted_scores) < 2:
        return 0.0

    def _ranks(values: Sequence[float]) -> list[float]:
        ordered = sorted((value, idx) for idx, value in enumerate(values))
        ranks = [0.0] * len(values)
        idx = 0
        while idx < len(ordered):
            end = idx
            while end + 1 < len(ordered) and ordered[end + 1][0] == ordered[idx][0]:
                end += 1
            rank = (idx + end + 2) / 2.0
            for _, original_idx in ordered[idx:end + 1]:
                ranks[original_idx] = rank
            idx = end + 1
        return ranks

    x = _ranks(predicted_scores)
    y = _ranks(gold_scores)
    x_mean = sum(x) / len(x)
    y_mean = sum(y) / len(y)
    numerator = sum((a - x_mean) * (b - y_mean) for a, b in zip(x, y))
    x_den = sqrt(sum((a - x_mean) ** 2 for a in x))
    y_den = sqrt(sum((b - y_mean) ** 2 for b in y))
    return numerator / (x_den * y_den) if x_den and y_den else 0.0


def cohens_kappa(labels_a: Sequence[str], labels_b: Sequence[str]) -> float:
    """Cohen's kappa for two annotators over categorical labels."""

    if len(labels_a) != len(labels_b) or not labels_a:
        return 0.0
    total = len(labels_a)
    observed = sum(a == b for a, b in zip(labels_a, labels_b)) / total
    counts_a = Counter(labels_a)
    counts_b = Counter(labels_b)
    expected = sum((counts_a[label] / total) * (counts_b[label] / total) for label in set(counts_a) | set(counts_b))
    if expected == 1.0:
        return 1.0
    return (observed - expected) / (1.0 - expected)


def mean(values: Sequence[float]) -> float:
    """Small dependency-free mean helper for evaluation scripts."""

    return sum(values) / len(values) if values else 0.0
