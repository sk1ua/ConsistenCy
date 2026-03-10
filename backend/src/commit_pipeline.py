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
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from git import Repo
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

import config
from .parser import CodeParser
from .storage import CodeStorage
from .utils import detect_naming_style


HUNK_RE = re.compile(r"@@ -(?P<o_start>\d+)(?:,(?P<o_count>\d+))? \+(?P<n_start>\d+)(?:,(?P<n_count>\d+))? @@")


@dataclass
class CommitContext:
    commit_id: str
    author: str
    message: str
    changed_files: List[str]
    changed_functions: List[Dict[str, Any]]


class CommitMiner:
    """从 git 历史中提取提交上下文。"""

    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path)
        self.repo = Repo(str(self.repo_path))
        self.parser = CodeParser()

    def get_commit(self, commit_sha: str) -> CommitContext:
        commit = self.repo.commit(commit_sha)
        parent = commit.parents[0] if commit.parents else None

        changed_files = []
        changed_functions: List[Dict[str, Any]] = []

        if parent:
            diffs = parent.diff(commit, create_patch=True)
        else:
            diffs = commit.diff(NULL_TREE, create_patch=True)  # type: ignore[name-defined]

        for diff in diffs:
            file_path = diff.b_path or diff.a_path
            if not file_path or not file_path.endswith(".py"):
                continue

            changed_files.append(file_path)
            source = self._read_file_from_commit(commit, file_path)
            if source is None:
                continue

            parsed = self.parser.parse_source(source=source, file_path=file_path)
            if not parsed:
                continue

            changed_lines = self._extract_changed_lines(diff.diff.decode("utf-8", errors="ignore"))
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
        )

    def list_recent_commits(self, max_count: int = 300) -> List[str]:
        commits = []
        for c in self.repo.iter_commits(max_count=max_count):
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
    """Neo4j 图谱 PoC（Author/Commit/File/Function）。"""

    def __init__(self, uri: Optional[str], user: Optional[str], password: Optional[str]):
        self.enabled = bool(uri and user and password)
        self.driver = None
        if self.enabled:
            from neo4j import GraphDatabase

            self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self):
        if self.driver:
            self.driver.close()

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
        if not self.driver:
            return []

        query = """
        MATCH (f:Function)<-[:TOUCHES_FUNCTION]-(c:Commit)-[:AUTHORED_BY]->(a:Author)
        OPTIONAL MATCH (c)-[:MODIFIES]->(fi:File)
        WHERE toLower(f.name) CONTAINS toLower($name)
        RETURN f.name AS function_name,
               c.sha AS commit_sha,
               a.name AS author,
               fi.path AS file_path,
               CASE WHEN toLower(f.name)=toLower($name) THEN 1.0 ELSE 0.7 END AS score
        LIMIT $k
        """

        with self.driver.session() as session:
            rows = session.run(query, name=function_name, k=top_k)
            return [
                {
                    "source": "graph",
                    "function_name": r["function_name"],
                    "commit_sha": r["commit_sha"],
                    "author": r["author"],
                    "file_path": r["file_path"],
                    "score": float(r["score"] or 0.0),
                }
                for r in rows
            ]

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
    """向量检索 + 图路径检索融合。"""

    def __init__(self, storage: CodeStorage, graph_store: Optional[Neo4jGraphStore] = None):
        self.storage = storage
        self.graph_store = graph_store

    def retrieve(self, fn: Dict[str, Any], top_k: int = 3) -> List[Dict[str, Any]]:
        query = f"{fn.get('signature', '')}\n{fn.get('snippet', '')}"
        vector_hits = self.storage.search_similar_functions(query, n_results=top_k)

        normalized_vector = []
        for h in vector_hits:
            dist = h.get("distance")
            v_score = 1 - float(dist) if dist is not None else 0.5
            normalized_vector.append(
                {
                    "source": "vector",
                    "function_name": h.get("metadata", {}).get("name", ""),
                    "file_path": h.get("metadata", {}).get("file_path", ""),
                    "document": h.get("document", ""),
                    "score": max(0.0, min(1.0, v_score)),
                }
            )

        graph_hits = []
        if self.graph_store:
            graph_hits = self.graph_store.query_function_paths(fn.get("name", ""), top_k=top_k)

        merged = normalized_vector + graph_hits
        merged.sort(key=lambda x: x.get("score", 0.0), reverse=True)
        return merged[:top_k]


class CommitRiskScorer:
    """输出三层风险分与证据。"""

    def __init__(self, storage: CodeStorage, retriever: HybridRetriever):
        self.storage = storage
        self.retriever = retriever

    def score(self, context: CommitContext, top_k: int = 3) -> Dict[str, Any]:
        if not context.changed_functions:
            return {
                "commit": context.commit_id,
                "style_risk": 0.0,
                "structure_risk": 0.0,
                "logic_risk": 0.0,
                "overall_risk": 0.0,
                "evidence": {"functions": []},
            }

        naming_rules = self.storage.get_naming_patterns() or config.CHECK_CONFIG["naming"]

        style_penalty = 0.0
        structure_penalty = 0.0
        logic_penalty = 0.0
        evidence = []

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
            best_score = hits[0]["score"] if hits else 0.0
            logic_bad = 1.0 - best_score
            logic_penalty += logic_bad

            evidence.append(
                {
                    "function": fn.get("name"),
                    "file": fn.get("file_path"),
                    "line": fn.get("lineno"),
                    "style": {"expected": expected, "actual": actual},
                    "top_hits": hits,
                }
            )

        n = float(len(context.changed_functions))
        style_risk = style_penalty / n
        structure_risk = structure_penalty / n
        logic_risk = logic_penalty / n
        overall = 0.4 * style_risk + 0.3 * structure_risk + 0.3 * logic_risk

        return {
            "commit": context.commit_id,
            "author": context.author,
            "changed_files": len(context.changed_files),
            "changed_functions": len(context.changed_functions),
            "style_risk": round(style_risk, 4),
            "structure_risk": round(structure_risk, 4),
            "logic_risk": round(logic_risk, 4),
            "overall_risk": round(overall, 4),
            "weak_label": 1 if overall >= 0.55 else 0,
            "evidence": {"functions": evidence[:top_k]},
        }


class WeakEvalRunner:
    """构建弱监督评估集并输出 P/R/F1。"""

    def __init__(self, repo_path: str, storage: CodeStorage, retriever: HybridRetriever):
        self.miner = CommitMiner(repo_path)
        self.scorer = CommitRiskScorer(storage=storage, retriever=retriever)
        self.output_dir = config.DATA_DIR / "eval"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(self, samples: int = 80, max_commits: int = 300) -> Dict[str, Any]:
        commit_shas = self.miner.list_recent_commits(max_count=max_commits)
        rows: List[Dict[str, Any]] = []

        for sha in commit_shas:
            if len(rows) >= samples:
                break
            ctx = self.miner.get_commit(sha)
            if not ctx.changed_functions:
                continue
            scored = self.scorer.score(ctx, top_k=3)
            rows.append(
                {
                    "commit": scored["commit"],
                    "style_risk": scored["style_risk"],
                    "structure_risk": scored["structure_risk"],
                    "logic_risk": scored["logic_risk"],
                    "overall_risk": scored["overall_risk"],
                }
            )

        if len(rows) < 20:
            return {
                "ok": False,
                "message": f"样本不足，至少20条，当前{len(rows)}条",
                "samples": len(rows),
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

        x_train, x_test, y_train, y_test = train_test_split(
            X, y, test_size=0.3, random_state=42, stratify=y if len(set(y)) > 1 else None
        )

        model = LogisticRegression(max_iter=300)
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
            "precision": round(float(p), 4),
            "recall": round(float(r), 4),
            "f1": round(float(f1), 4),
        }


# GitPython 在无 parent 的场景中需要该常量
NULL_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
