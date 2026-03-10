# -*- coding: utf-8 -*-
"""
提交级一致性 MVP 管线：
- Commit 采集
- Neo4j 图谱 PoC
- 向量 + 图融合检索
- 三层风险评分
- 弱监督评估
"""
from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from git import Repo
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

import config
from .parser import CodeParser
from .storage import CodeStorage
from .utils import detect_naming_style

# Git 空树哈希常量：表示仓库初始提交前的虚拟空树
NULL_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

HUNK_RE = re.compile(r"@@ -(?P<o_start>\d+)(?:,(?P<o_count>\d+))? \+(?P<n_start>\d+)(?:,(?P<n_count>\d+))? @@")


@dataclass
class CommitContext:
    commit_id: str
    author: str
    message: str
    changed_files: List[str]
    changed_functions: List[Dict[str, Any]]
    deleted_files: List[str]


class CommitMiner:
    """从 git 历史中提取提交上下文。"""

    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path)
        self.repo = Repo(str(self.repo_path))
        self.parser = CodeParser()

    def get_commit(self, commit_sha: str) -> CommitContext:
        commit = self.repo.commit(commit_sha)
        parent = commit.parents[0] if commit.parents else None

        changed_files: List[str] = []
        changed_functions: List[Dict[str, Any]] = []
        deleted_files: List[str] = []

        if parent:
            diffs = parent.diff(commit, create_patch=True)
        else:
            diffs = commit.diff(NULL_TREE, create_patch=True)  # type: ignore[name-defined]

        for diff in diffs:
            old_path = diff.a_path
            new_path = diff.b_path
            file_path = new_path or old_path
            if not file_path or not file_path.endswith(".py"):
                continue

            changed_files.append(file_path)

            # 删除文件不在当前提交树中，记录删除证据后跳过源码解析。
            if old_path and not new_path:
                deleted_files.append(old_path)
                continue

            source = self._read_file_from_commit(commit, file_path)
            if source is None:
                continue

            parsed = self.parser.parse_source(source=source, file_path=file_path)
            if not parsed:
                continue

            changed_lines = self._extract_changed_lines(self._decode_patch(diff.diff))
            if not changed_lines:
                continue
            for fn in parsed.get("functions", []):
                if self._function_touched(fn, changed_lines):
                    fn_copy = dict(fn)
                    fn_copy["file_path"] = file_path
                    fn_copy["signature"] = self._signature(fn)
                    fn_copy["snippet"] = self._snippet(source, fn["lineno"], fn.get("end_lineno", fn["lineno"]))
                    changed_functions.append(fn_copy)

        return CommitContext(
            commit_id=commit.hexsha,
            author=commit.author.name,
            message=commit.message.strip(),
            changed_files=sorted(set(changed_files)),
            changed_functions=changed_functions,
            deleted_files=sorted(set(deleted_files)),
        )

    def list_recent_commits(self, max_count: int = 300, rev: str = "HEAD") -> List[str]:
        commits = []
        for c in self.repo.iter_commits(rev=rev, max_count=max_count):
            if len(c.parents) > 1:
                continue
            commits.append(c.hexsha)
        return commits

    def _read_file_from_commit(self, commit, file_path: str) -> Optional[str]:
        try:
            blob = commit.tree / file_path
            return blob.data_stream.read().decode("utf-8", errors="ignore")
        except Exception:
            return None

    def _decode_patch(self, patch_blob: Any) -> str:
        if patch_blob is None:
            return ""
        if isinstance(patch_blob, bytes):
            return patch_blob.decode("utf-8", errors="ignore")
        return str(patch_blob)

    def _extract_changed_lines(self, patch_text: str) -> List[int]:
        lines: List[int] = []
        for m in HUNK_RE.finditer(patch_text):
            start = int(m.group("n_start"))
            count = int(m.group("n_count") or "1")
            for i in range(start, start + max(count, 1)):
                lines.append(i)
        return lines

    def _function_touched(self, fn: Dict[str, Any], changed_lines: List[int]) -> bool:
        start = fn.get("lineno", 0)
        end = fn.get("end_lineno", start)
        return any(start <= line <= end for line in changed_lines)

    def _signature(self, fn: Dict[str, Any]) -> str:
        args = ", ".join(fn.get("args", []))
        prefix = "async " if fn.get("is_async") else ""
        return f"{prefix}def {fn.get('name', 'unknown')}({args})"

    def _snippet(self, source: str, start: int, end: int) -> str:
        all_lines = source.splitlines()
        s = max(1, start)
        e = min(len(all_lines), end)
        return "\n".join(all_lines[s - 1:e])


class Neo4jGraphStore:
    """
    Neo4j 图谱 PoC（Author/Commit/File/Function）。
    M2: 增强批量入库、错误处理、查询能力。
    """

    def __init__(self, uri: Optional[str], user: Optional[str], password: Optional[str]):
        self.enabled = bool(uri and user and password)
        self.driver = None
        if self.enabled:
            from neo4j import GraphDatabase

            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            self._verify_connectivity()

    def _verify_connectivity(self):
        """M2: 验证连接健康"""
        if not self.driver:
            return
        try:
            with self.driver.session() as session:
                session.run("RETURN 1")
        except Exception as e:
            print(f"⚠️  Neo4j 连接失败: {e}")
            self.enabled = False
            self.driver = None

    def close(self):
        if self.driver:
            self.driver.close()

    def get_stats(self) -> Dict[str, Any]:
        """M2: 获取图谱统计信息"""
        if not self.driver:
            return {"enabled": False}

        query = """
        MATCH (a:Author) WITH count(a) AS authors
        MATCH (c:Commit) WITH authors, count(c) AS commits
        MATCH (f:File) WITH authors, commits, count(f) AS files
        MATCH (fn:Function) WITH authors, commits, files, count(fn) AS functions
        RETURN authors, commits, files, functions
        """

        try:
            with self.driver.session() as session:
                result = session.run(query).single()
                return {
                    "enabled": True,
                    "authors": result["authors"] if result else 0,
                    "commits": result["commits"] if result else 0,
                    "files": result["files"] if result else 0,
                    "functions": result["functions"] if result else 0,
                }
        except Exception as e:
            return {"enabled": True, "error": str(e)}

    def ingest_commits_batch(self, contexts: List[CommitContext]) -> Dict[str, Any]:
        """M2: 批量入库提交数据"""
        if not self.driver:
            return {"ok": False, "message": "Neo4j not enabled"}

        ingested = 0
        failed = 0
        errors = []

        for ctx in contexts:
            try:
                self.ingest_commit(ctx)
                ingested += 1
            except Exception as e:
                failed += 1
                if len(errors) < 3:
                    errors.append(f"{ctx.commit_id[:8]}: {e}")

        return {
            "ok": True,
            "ingested": ingested,
            "failed": failed,
            "errors": errors,
        }

    def ingest_commit(self, context: CommitContext):
        if not self.driver:
            return
        with self.driver.session() as session:
            session.execute_write(self._merge_author_commit, context)
            for path in context.changed_files:
                session.execute_write(self._merge_file_rel, context.commit_id, path)
            for fn in context.changed_functions:
                session.execute_write(self._merge_function_rel, context.commit_id, fn)

    def query_function_paths(self, function_name: str, top_k: int = 3) -> List[Dict[str, Any]]:
        """M2: 增强图路径查询，返回更丰富的上下文"""
        if not self.driver:
            return []

        query = """
        MATCH (f:Function)<-[:TOUCHES_FUNCTION]-(c:Commit)-[:AUTHORED_BY]->(a:Author)
        OPTIONAL MATCH (c)-[:MODIFIES]->(fi:File)
        WHERE toLower(f.name) CONTAINS toLower($name)
        WITH f, c, a, fi,
             CASE WHEN toLower(f.name)=toLower($name) THEN 1.0 ELSE 0.7 END AS base_score
        RETURN f.name AS function_name,
               f.file_path AS function_file,
               f.line AS function_line,
               c.sha AS commit_sha,
               c.message AS commit_message,
               a.name AS author,
               collect(DISTINCT fi.path) AS modified_files,
               base_score AS score
        ORDER BY base_score DESC, c.sha DESC
        LIMIT $k
        """

        try:
            with self.driver.session() as session:
                rows = session.run(query, name=function_name, k=top_k)
                return [
                    {
                        "source": "graph",
                        "function_name": r["function_name"],
                        "function_file": r["function_file"],
                        "function_line": int(r["function_line"] or 0),
                        "commit_sha": r["commit_sha"],
                        "commit_message": (r["commit_message"] or "")[:100],
                        "author": r["author"],
                        "modified_files": r["modified_files"] or [],
                        "score": float(r["score"] or 0.0),
                    }
                    for r in rows
                ]
        except Exception as e:
            print(f"⚠️  图查询失败: {e}")
            return []

    def query_similar_by_author(self, author: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """M2: 根据作者查找相关函数修改"""
        if not self.driver:
            return []

        query = """
        MATCH (a:Author {name: $author})<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES_FUNCTION]->(f:Function)
        RETURN DISTINCT f.name AS function_name,
               f.file_path AS file_path,
               count(c) AS touch_count
        ORDER BY touch_count DESC
        LIMIT $k
        """

        try:
            with self.driver.session() as session:
                rows = session.run(query, author=author, k=top_k)
                return [
                    {
                        "function_name": r["function_name"],
                        "file_path": r["file_path"],
                        "touch_count": int(r["touch_count"] or 0),
                    }
                    for r in rows
                ]
        except Exception:
            return []

    @staticmethod
    def _merge_author_commit(tx, context: CommitContext):
        tx.run(
            """
            MERGE (a:Author {name: $author})
            MERGE (c:Commit {sha: $sha})
            SET c.message = $message
            MERGE (c)-[:AUTHORED_BY]->(a)
            """,
            author=context.author,
            sha=context.commit_id,
            message=context.message,
        )

    @staticmethod
    def _merge_file_rel(tx, commit_id: str, file_path: str):
        tx.run(
            """
            MERGE (c:Commit {sha: $sha})
            MERGE (f:File {path: $path})
            MERGE (c)-[:MODIFIES]->(f)
            """,
            sha=commit_id,
            path=file_path,
        )

    @staticmethod
    def _merge_function_rel(tx, commit_id: str, fn: Dict[str, Any]):
        tx.run(
            """
            MERGE (f:Function {name: $name, file_path: $file_path})
            SET f.line = $line
            MERGE (c:Commit {sha: $sha})
            MERGE (c)-[:TOUCHES_FUNCTION]->(f)
            """,
            name=fn.get("name"),
            file_path=fn.get("file_path", ""),
            line=int(fn.get("lineno", 0)),
            sha=commit_id,
        )


class HybridRetriever:
    """
    向量检索 + 图路径检索融合。
    M2: 实现多种融合策略（加权、RRF、线性组合）。
    """

    def __init__(
        self,
        storage: CodeStorage,
        graph_store: Optional[Neo4jGraphStore] = None,
        fusion_method: Optional[str] = None,
    ):
        self.storage = storage
        self.graph_store = graph_store
        self.fusion_method = fusion_method or config.HYBRID_RETRIEVAL_CONFIG["fusion_method"]
        self.vector_weight = config.HYBRID_RETRIEVAL_CONFIG["vector_weight"]
        self.graph_weight = config.HYBRID_RETRIEVAL_CONFIG["graph_weight"]
        self.rrf_k = config.HYBRID_RETRIEVAL_CONFIG["rrf_k"]

    def retrieve(self, fn: Dict[str, Any], top_k: int = 3) -> List[Dict[str, Any]]:
        """统一检索接口，根据配置选择融合方法"""
        query = f"{fn.get('signature', '')}\n{fn.get('snippet', '')}"
        vector_hits = self._retrieve_vector(query, top_k * 2)
        graph_hits = self._retrieve_graph(fn.get("name", ""), top_k * 2) if self.graph_store else []

        if self.fusion_method == "rrf":
            merged = self._fuse_rrf(vector_hits, graph_hits)
        elif self.fusion_method == "linear_combination":
            merged = self._fuse_linear(vector_hits, graph_hits)
        else:  # weighted_sum
            merged = self._fuse_weighted(vector_hits, graph_hits)

        return merged[:top_k]

    def retrieve_vector_only(self, fn: Dict[str, Any], top_k: int = 3) -> List[Dict[str, Any]]:
        """M2: 向量单独检索baseline"""
        query = f"{fn.get('signature', '')}\n{fn.get('snippet', '')}"
        return self._retrieve_vector(query, top_k)

    def retrieve_graph_only(self, fn: Dict[str, Any], top_k: int = 3) -> List[Dict[str, Any]]:
        """M2: 图单独检索baseline"""
        if not self.graph_store:
            return []
        return self._retrieve_graph(fn.get("name", ""), top_k)

    def _retrieve_vector(self, query: str, top_k: int) -> List[Dict[str, Any]]:
        """向量检索"""
        vector_hits = self.storage.search_similar_functions(query, n_results=top_k)
        normalized = []
        for h in vector_hits:
            dist = h.get("distance")
            v_score = 1 - float(dist) if dist is not None else 0.5
            normalized.append(
                {
                    "source": "vector",
                    "function_name": h.get("metadata", {}).get("name", ""),
                    "file_path": h.get("metadata", {}).get("file_path", ""),
                    "document": h.get("document", ""),
                    "score": max(0.0, min(1.0, v_score)),
                }
            )
        return normalized

    def _retrieve_graph(self, function_name: str, top_k: int) -> List[Dict[str, Any]]:
        """图检索"""
        return self.graph_store.query_function_paths(function_name, top_k=top_k)

    def _fuse_weighted(
        self, vector_hits: List[Dict[str, Any]], graph_hits: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """加权融合：score = w1*vector_score + w2*graph_score"""
        for h in vector_hits:
            h["fused_score"] = h["score"] * self.vector_weight
        for h in graph_hits:
            h["fused_score"] = h["score"] * self.graph_weight

        merged = vector_hits + graph_hits
        merged.sort(key=lambda x: x.get("fused_score", 0.0), reverse=True)
        return merged

    def _fuse_rrf(
        self, vector_hits: List[Dict[str, Any]], graph_hits: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Reciprocal Rank Fusion: score = sum(1/(k + rank))"""
        score_dict: Dict[str, Dict[str, Any]] = {}

        for rank, h in enumerate(vector_hits, start=1):
            key = f"{h.get('function_name', '')}@{h.get('file_path', '')}"
            if key not in score_dict:
                score_dict[key] = h.copy()
                score_dict[key]["fused_score"] = 0.0
            score_dict[key]["fused_score"] += 1.0 / (self.rrf_k + rank)

        for rank, h in enumerate(graph_hits, start=1):
            key = f"{h.get('function_name', '')}@{h.get('file_path', '')}"
            if key not in score_dict:
                score_dict[key] = h.copy()
                score_dict[key]["fused_score"] = 0.0
            score_dict[key]["fused_score"] += 1.0 / (self.rrf_k + rank)

        merged = list(score_dict.values())
        merged.sort(key=lambda x: x.get("fused_score", 0.0), reverse=True)
        return merged

    def _fuse_linear(
        self, vector_hits: List[Dict[str, Any]], graph_hits: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """线性组合：归一化后加权"""
        def normalize_scores(hits: List[Dict[str, Any]]) -> None:
            if not hits:
                return
            scores = [h.get("score", 0.0) for h in hits]
            min_s, max_s = min(scores), max(scores)
            if max_s - min_s > 1e-6:
                for h in hits:
                    h["norm_score"] = (h["score"] - min_s) / (max_s - min_s)
            else:
                for h in hits:
                    h["norm_score"] = 1.0

        normalize_scores(vector_hits)
        normalize_scores(graph_hits)

        for h in vector_hits:
            h["fused_score"] = h.get("norm_score", 0.0) * self.vector_weight
        for h in graph_hits:
            h["fused_score"] = h.get("norm_score", 0.0) * self.graph_weight

        merged = vector_hits + graph_hits
        merged.sort(key=lambda x: x.get("fused_score", 0.0), reverse=True)
        return merged


class CommitRiskScorer:
    """
    输出三层风险分与证据。
    M2: 支持可配置权重和自动调优。
    """

    def __init__(
        self,
        storage: CodeStorage,
        retriever: HybridRetriever,
        weights: Optional[Dict[str, float]] = None,
    ):
        self.storage = storage
        self.retriever = retriever
        self.weights = weights or self._load_weights()

    def _load_weights(self) -> Dict[str, float]:
        """加载权重：优先使用调优后的，否则使用默认值"""
        tuned_file = config.RISK_SCORING_CONFIG["tuned_weights_file"]
        if config.RISK_SCORING_CONFIG.get("auto_tune_enabled") and tuned_file.exists():
            try:
                import json
                with open(tuned_file, "r", encoding="utf-8") as f:
                    tuned = json.load(f)
                    return tuned.get("weights", config.RISK_SCORING_CONFIG["default_weights"])
            except Exception:
                pass
        return config.RISK_SCORING_CONFIG["default_weights"].copy()

    def score(self, context: CommitContext, top_k: int = 3) -> Dict[str, Any]:
        if not context.changed_functions:
            structure_risk = min(1.0, 0.2 * len(context.deleted_files)) if context.deleted_files else 0.0
            overall = 0.3 * structure_risk
            return {
                "commit": context.commit_id,
                "author": context.author,
                "changed_files": len(context.changed_files),
                "changed_functions": 0,
                "deleted_files": len(context.deleted_files),
                "style_risk": 0.0,
                "structure_risk": round(structure_risk, 4),
                "logic_risk": 0.0,
                "overall_risk": round(overall, 4),
                "weak_label": 1 if overall >= 0.55 else 0,
                "evidence": {
                    "functions": [],
                    "deleted_files": context.deleted_files,
                },
            }

        naming_rules = self.storage.get_naming_patterns() or config.CHECK_CONFIG["naming"]

        style_penalty = 0.0
        structure_penalty = 0.0
        logic_penalty = 0.0
        evidence = []
        neutral_logic_penalty = config.COMMIT_PIPELINE_CONFIG["neutral_logic_penalty_when_no_evidence"]

        for fn in context.changed_functions:
            expected = naming_rules.get("function", "snake_case")
            actual = detect_naming_style(fn.get("name", ""))
            style_bad = 1.0 if actual != expected else 0.0
            style_penalty += style_bad

            line_span = max(1, int(fn.get("end_lineno", fn.get("lineno", 1))) - int(fn.get("lineno", 1)) + 1)
            param_count = len(fn.get("args", []))
            structure_bad = 0.0
            if line_span > config.CHECK_CONFIG["max_function_length"]:
                structure_bad += 0.7
            if param_count > 5:
                structure_bad += 0.3
            structure_penalty += min(1.0, structure_bad)

            hits = self.retriever.retrieve(fn, top_k=top_k)
            if hits:
                best_score = max(0.0, min(1.0, float(hits[0].get("score", 0.0))))
                logic_bad = 1.0 - best_score
                evidence_state = "retrieved"
            else:
                logic_bad = neutral_logic_penalty
                evidence_state = "no_evidence"
            logic_penalty += logic_bad

            evidence.append(
                {
                    "function": fn.get("name"),
                    "file": fn.get("file_path"),
                    "line": fn.get("lineno"),
                    "style": {"expected": expected, "actual": actual},
                    "logic_penalty": round(logic_bad, 4),
                    "evidence_state": evidence_state,
                    "top_hits": hits,
                }
            )

        n = float(len(context.changed_functions))
        style_risk = style_penalty / n
        structure_risk = structure_penalty / n
        logic_risk = logic_penalty / n
        
        # M2: 使用可配置权重
        w_style = self.weights.get("style", 0.4)
        w_structure = self.weights.get("structure", 0.3)
        w_logic = self.weights.get("logic", 0.3)
        overall = w_style * style_risk + w_structure * structure_risk + w_logic * logic_risk
        
        ranked_evidence = sorted(
            evidence,
            key=lambda item: (
                item.get("logic_penalty", 0.0),
                1 if item.get("style", {}).get("expected") != item.get("style", {}).get("actual") else 0,
            ),
            reverse=True,
        )

        return {
            "commit": context.commit_id,
            "author": context.author,
            "changed_files": len(context.changed_files),
            "changed_functions": len(context.changed_functions),
            "deleted_files": len(context.deleted_files),
            "style_risk": round(style_risk, 4),
            "structure_risk": round(structure_risk, 4),
            "logic_risk": round(logic_risk, 4),
            "overall_risk": round(overall, 4),
            "weak_label": 1 if overall >= 0.55 else 0,
            "weights_used": {"style": w_style, "structure": w_structure, "logic": w_logic},
            "evidence": {
                "functions": ranked_evidence[:top_k],
                "deleted_files": context.deleted_files,
            },
        }


class WeakEvalRunner:
    """构建弱监督评估集并输出 P/R/F1。"""

    def __init__(self, repo_path: str, storage: CodeStorage, retriever: HybridRetriever):
        self.miner = CommitMiner(repo_path)
        self.scorer = CommitRiskScorer(storage=storage, retriever=retriever)
        self.output_dir = config.DATA_DIR / "eval"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        samples: int = 80,
        max_commits: int = 300,
        seed: int = config.COMMIT_PIPELINE_CONFIG["default_eval_seed"],
        rev: str = config.COMMIT_PIPELINE_CONFIG["default_eval_rev"],
    ) -> Dict[str, Any]:
        random.seed(seed)
        commit_shas = self.miner.list_recent_commits(max_count=max_commits, rev=rev)
        rows: List[Dict[str, Any]] = []
        skipped_commits = 0
        error_examples: List[str] = []

        for sha in commit_shas:
            if len(rows) >= samples:
                break
            try:
                ctx = self.miner.get_commit(sha)
                if not ctx.changed_functions and not ctx.deleted_files:
                    continue
                scored = self.scorer.score(ctx, top_k=3)
            except Exception as exc:
                skipped_commits += 1
                if len(error_examples) < 3:
                    error_examples.append(f"{sha[:10]}: {exc}")
                continue

            rows.append(
                {
                    "commit": scored["commit"],
                    "style_risk": scored["style_risk"],
                    "structure_risk": scored["structure_risk"],
                    "logic_risk": scored["logic_risk"],
                    "overall_risk": scored["overall_risk"],
                }
            )

        min_samples = config.COMMIT_PIPELINE_CONFIG["min_eval_samples"]
        if len(rows) < min_samples:
            return {
                "ok": False,
            "message": f"样本不足，至少{min_samples}条，当前{len(rows)}条",
                "samples": len(rows),
                "skipped_commits": skipped_commits,
                "seed": seed,
                "rev": rev,
                "errors": error_examples,
            }

        # 使用分位数阈值生成弱监督标签，避免标签单一导致指标退化。
        scores = sorted(r["overall_risk"] for r in rows)
        q_idx = max(0, int(0.65 * (len(scores) - 1)))
        threshold = scores[q_idx]
        for row in rows:
            row["label"] = 1 if row["overall_risk"] >= threshold else 0

        dataset_path = self.output_dir / "weak_eval_dataset.jsonl"
        with open(dataset_path, "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

        X = [[r["style_risk"], r["structure_risk"], r["logic_risk"], r["overall_risk"]] for r in rows]
        y = [r["label"] for r in rows]

        if len(set(y)) < 2:
            return {
                "ok": False,
                "message": "弱标签分布单一，无法训练评估模型",
                "samples": len(rows),
                "skipped_commits": skipped_commits,
                "seed": seed,
                "rev": rev,
            }

        x_train, x_test, y_train, y_test = train_test_split(
            X,
            y,
            test_size=0.3,
            random_state=seed,
            stratify=y if len(set(y)) > 1 else None,
        )

        model = LogisticRegression(max_iter=300, random_state=seed)
        model.fit(x_train, y_train)
        y_pred = model.predict(x_test)

        p = precision_score(y_test, y_pred, zero_division=0)
        r = recall_score(y_test, y_pred, zero_division=0)
        f1 = f1_score(y_test, y_pred, zero_division=0)

        return {
            "ok": True,
            "samples": len(rows),
            "weak_label_threshold": round(float(threshold), 4),
            "dataset_path": str(dataset_path),
            "seed": seed,
            "rev": rev,
            "skipped_commits": skipped_commits,
            "precision": round(float(p), 4),
            "recall": round(float(r), 4),
            "f1": round(float(f1), 4),
            "errors": error_examples,
        }


class RiskWeightTuner:
    """
    M2: 风险评分权重自动调优。
    基于评估数据集通过网格搜索找到最优权重组合。
    """

    def __init__(self, dataset_path: str):
        self.dataset_path = Path(dataset_path)
        self.best_weights: Optional[Dict[str, float]] = None
        self.best_f1: float = 0.0

    def tune(self, grid_step: float = 0.1) -> Dict[str, Any]:
        """网格搜索最优权重"""
        if not self.dataset_path.exists():
            return {"ok": False, "message": f"数据集不存在: {self.dataset_path}"}

        # 加载数据
        rows = []
        with open(self.dataset_path, "r", encoding="utf-8") as f:
            for line in f:
                rows.append(json.loads(line))

        if len(rows) < 10:
            return {"ok": False, "message": "样本不足"}

        # 网格搜索
        best_f1 = 0.0
        best_weights = config.RISK_SCORING_CONFIG["default_weights"].copy()
        candidates = []

        # 生成权重候选（确保总和为1）
        for w_style in [i * grid_step for i in range(1, 10)]:  # 0.1 ~ 0.9
            for w_structure in [i * grid_step for i in range(1, 10)]:
                w_logic = max(0.0, min(1.0, 1.0 - w_style - w_structure))
                if abs(w_style + w_structure + w_logic - 1.0) < 0.01:
                    candidates.append({"style": w_style, "structure": w_structure, "logic": w_logic})

        # 评估每组权重
        for weights in candidates:
            overall_risks = [
                weights["style"] * r["style_risk"]
                + weights["structure"] * r["structure_risk"]
                + weights["logic"] * r["logic_risk"]
                for r in rows
            ]
            
            # 使用中位数作为阈值
            threshold = sorted(overall_risks)[len(overall_risks) // 2]
            y_pred = [1 if risk >= threshold else 0 for risk in overall_risks]
            y_true = [r.get("label", 0) for r in rows]

            f1 = f1_score(y_true, y_pred, zero_division=0)
            if f1 > best_f1:
                best_f1 = f1
                best_weights = weights.copy()

        self.best_weights = best_weights
        self.best_f1 = best_f1

        # 保存结果
        output_file = config.RISK_SCORING_CONFIG["tuned_weights_file"]
        result = {
            "weights": best_weights,
            "f1_score": round(float(best_f1), 4),
            "tuned_at": str(Path(__file__).stat().st_mtime),
            "dataset": str(self.dataset_path),
        }
        
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        return {
            "ok": True,
            "best_weights": best_weights,
            "best_f1": round(float(best_f1), 4),
            "candidates_tested": len(candidates),
            "output_file": str(output_file),
        }


class RetrievalComparer:
    """
    M2: 检索方法对比实验（向量/图/融合）。
    """

    def __init__(
        self,
        repo_path: str,
        storage: CodeStorage,
        graph_store: Optional[Neo4jGraphStore] = None,
    ):
        self.miner = CommitMiner(repo_path)
        self.storage = storage
        self.graph_store = graph_store

    def compare(
        self,
        commit_sha: str,
        top_k: int = 3,
    ) -> Dict[str, Any]:
        """对比单一提交的三种检索方法"""
        try:
            ctx = self.miner.get_commit(commit_sha)
        except Exception as e:
            return {"ok": False, "message": f"提交解析失败: {e}"}

        if not ctx.changed_functions:
            return {"ok": False, "message": "无函数修改"}

        # 创建不同配置的检索器
        retriever_hybrid = HybridRetriever(self.storage, self.graph_store, fusion_method="weighted_sum")
        retriever_rrf = HybridRetriever(self.storage, self.graph_store, fusion_method="rrf")

        comparisons = []
        for fn in ctx.changed_functions[:3]:  # 只对比前3个函数
            vector_only = retriever_hybrid.retrieve_vector_only(fn, top_k)
            graph_only = retriever_hybrid.retrieve_graph_only(fn, top_k) if self.graph_store else []
            hybrid_weighted = retriever_hybrid.retrieve(fn, top_k)
            hybrid_rrf = retriever_rrf.retrieve(fn, top_k)

            comparisons.append(
                {
                    "function": fn.get("name"),
                    "vector_only": {
                        "count": len(vector_only),
                        "top_score": vector_only[0].get("score", 0.0) if vector_only else 0.0,
                    },
                    "graph_only": {
                        "count": len(graph_only),
                        "top_score": graph_only[0].get("score", 0.0) if graph_only else 0.0,
                    },
                    "hybrid_weighted": {
                        "count": len(hybrid_weighted),
                        "top_score": hybrid_weighted[0].get("fused_score", 0.0) if hybrid_weighted else 0.0,
                    },
                    "hybrid_rrf": {
                        "count": len(hybrid_rrf),
                        "top_score": hybrid_rrf[0].get("fused_score", 0.0) if hybrid_rrf else 0.0,
                    },
                }
            )

        return {
            "ok": True,
            "commit": commit_sha[:10],
            "comparisons": comparisons,
            "graph_available": self.graph_store is not None and self.graph_store.enabled,
        }
