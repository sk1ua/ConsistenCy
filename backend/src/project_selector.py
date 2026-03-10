# -*- coding: utf-8 -*-
"""
M4 - 项目选择与提交采样

用于：
  1. 从 GitHub 按条件筛选待标注的 Python 开源项目
  2. 从选定项目中分层采样提交，生成标注批次
"""
import json
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).parent.parent))
import config


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class ProjectCriteria:
    """筛选项目的标准"""
    language: str = "Python"
    min_stars: int = 200
    min_commits: int = 100
    max_commits: int = 20000
    min_contributors: int = 3
    min_age_months: int = 12      # 项目存活至少 1 年
    max_age_months: int = 120     # 不超过 10 年（避免过时巨型仓库）
    exclude_forks: bool = True
    exclude_archived: bool = True
    topics: List[str] = field(default_factory=list)  # 留空 = 不限制主题


@dataclass
class SelectedProject:
    """已选定的项目"""
    full_name: str          # "owner/repo"
    html_url: str
    clone_url: str
    stars: int
    forks: int
    open_issues: int
    description: str
    default_branch: str
    created_at: str
    updated_at: str
    sampled_commits: List[str] = field(default_factory=list)
    annotation_batch_path: Optional[str] = None


# ---------------------------------------------------------------------------
# GitHub API 封装（无依赖，仅用 urllib）
# ---------------------------------------------------------------------------

class GitHubAPI:
    """轻量级 GitHub REST API v3 封装"""

    BASE = "https://api.github.com"

    def __init__(self, token: Optional[str] = None):
        """
        Args:
            token: GitHub Personal Access Token（可选；无 token 限速 60 req/h）
        """
        self._token = token or os.environ.get("GITHUB_ACCESS_TOKEN", "")

    def _headers(self) -> Dict[str, str]:
        h = {"Accept": "application/vnd.github+json",
             "User-Agent": "ConsistenCy-M4/1.0"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _get(self, url: str, params: Optional[Dict] = None) -> Any:
        if params:
            qs = "&".join(f"{k}={v}" for k, v in params.items())
            url = f"{url}?{qs}"
        req = urlrequest.Request(url, headers=self._headers())
        try:
            with urlrequest.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode())
        except HTTPError as e:
            if e.code == 403:
                raise RuntimeError(
                    "GitHub API 限速或权限不足。请设置环境变量 GITHUB_ACCESS_TOKEN。"
                ) from e
            raise

    def search_repos(self, query: str, sort: str = "stars",
                     per_page: int = 30, page: int = 1) -> Dict:
        return self._get(
            f"{self.BASE}/search/repositories",
            {"q": query, "sort": sort, "order": "desc",
             "per_page": per_page, "page": page},
        )

    def get_repo(self, full_name: str) -> Dict:
        return self._get(f"{self.BASE}/repos/{full_name}")

    def get_contributors_count(self, full_name: str) -> int:
        """返回贡献者数（取首页 per_page=1，用 Link header 解析 last page）"""
        url = f"{self.BASE}/repos/{full_name}/contributors"
        req = urlrequest.Request(
            f"{url}?per_page=1&anon=true", headers=self._headers()
        )
        try:
            with urlrequest.urlopen(req, timeout=20) as resp:
                link = resp.headers.get("Link", "")
                if 'rel="last"' in link:
                    # Link: <...?page=N>; rel="last"
                    for part in link.split(","):
                        if 'rel="last"' in part:
                            page_str = part.split("page=")[-1].split(">")[0]
                            return int(page_str)
                return 1
        except (HTTPError, URLError):
            return 0


# ---------------------------------------------------------------------------
# 项目选择器
# ---------------------------------------------------------------------------

class ProjectSelector:
    """从 GitHub 搜索并筛选符合 M4 标准的开源项目"""

    def __init__(self, criteria: Optional[ProjectCriteria] = None,
                 token: Optional[str] = None):
        self.criteria = criteria or ProjectCriteria()
        self.api = GitHubAPI(token=token)

    def build_query(self) -> str:
        c = self.criteria
        parts = [f"language:{c.language}",
                 f"stars:>={c.min_stars}"]
        if c.exclude_forks:
            parts.append("fork:false")
        if c.exclude_archived:
            parts.append("archived:false")
        # 按创建时间限制年龄
        cutoff_new = datetime.utcnow() - timedelta(days=30 * c.min_age_months)
        cutoff_old = datetime.utcnow() - timedelta(days=30 * c.max_age_months)
        parts.append(f"created:{cutoff_old.strftime('%Y-%m-%d')}"
                     f"..{cutoff_new.strftime('%Y-%m-%d')}")
        if c.topics:
            parts.extend(f"topic:{t}" for t in c.topics)
        return " ".join(parts)

    def _passes_filter(self, repo: Dict, contributors: int) -> bool:
        c = self.criteria
        if contributors < c.min_contributors:
            return False
        # GitHub search API 不提供 commit count，跳过该过滤（CommitSampler 会处理）
        return True

    def select(self, n: int = 10, rate_limit_pause: float = 1.5) -> List[SelectedProject]:
        """
        搜索并返回 n 个符合条件的项目。

        Args:
            n: 目标项目数量
            rate_limit_pause: 每次 API 调用间的暂停秒数（避免限速）
        """
        query = self.build_query()
        print(f"[ProjectSelector] 搜索 GitHub: {query}")

        selected: List[SelectedProject] = []
        page = 1
        seen: set = set()

        while len(selected) < n:
            results = self.api.search_repos(query, per_page=30, page=page)
            items = results.get("items", [])
            if not items:
                print("[ProjectSelector] 搜索结果已耗尽")
                break

            for repo in items:
                if len(selected) >= n:
                    break
                full_name = repo["full_name"]
                if full_name in seen:
                    continue
                seen.add(full_name)

                time.sleep(rate_limit_pause)
                try:
                    contributors = self.api.get_contributors_count(full_name)
                except RuntimeError as e:
                    print(f"  [跳过] {full_name}: {e}")
                    continue

                if not self._passes_filter(repo, contributors):
                    print(f"  [过滤] {full_name} (贡献者 {contributors} < "
                          f"{self.criteria.min_contributors})")
                    continue

                sp = SelectedProject(
                    full_name=full_name,
                    html_url=repo["html_url"],
                    clone_url=repo["clone_url"],
                    stars=repo["stargazers_count"],
                    forks=repo["forks_count"],
                    open_issues=repo["open_issues_count"],
                    description=repo.get("description") or "",
                    default_branch=repo.get("default_branch", "main"),
                    created_at=repo.get("created_at", ""),
                    updated_at=repo.get("updated_at", ""),
                )
                selected.append(sp)
                print(f"  [选中] {full_name} ⭐{sp.stars}  贡献者 {contributors}")

            page += 1

        print(f"\n[ProjectSelector] 共选定 {len(selected)} 个项目")
        return selected

    def save(self, projects: List[SelectedProject], output_path: Optional[str] = None) -> Path:
        """保存项目列表到 JSON 文件"""
        if output_path is None:
            out = config.DATA_DIR / "projects" / "selected_projects.json"
        else:
            out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        data = [p.__dict__ for p in projects]
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"[ProjectSelector] 已保存 → {out}")
        return out

    @staticmethod
    def load(path: Optional[str] = None) -> List[SelectedProject]:
        """从 JSON 文件加载项目列表"""
        if path is None:
            p = config.DATA_DIR / "projects" / "selected_projects.json"
        else:
            p = Path(path)
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return [SelectedProject(**d) for d in data]


# ---------------------------------------------------------------------------
# 提交采样器
# ---------------------------------------------------------------------------

class CommitSampler:
    """
    从 Git 仓库中分层采样提交，生成标注批次。

    分层策略：
      - 按时间段均匀覆盖（早/中/近各 1/3）
      - 同一作者的提交限额，避免单作者偏差
    """

    def __init__(self, repo_path: str, project_name: str):
        """
        Args:
            repo_path: 本地 Git 仓库路径（已 clone）
            project_name: 项目标识名（用于输出文件命名）
        """
        try:
            from git import Repo, InvalidGitRepositoryError
            self.repo = Repo(str(repo_path))
        except ImportError:
            raise ImportError("gitpython 未安装。请运行: pip install gitpython")
        self.project_name = project_name
        self.repo_path = Path(repo_path)

    def _get_all_commits(self) -> List[Any]:
        """获取全部 commit（按时间倒序）"""
        return list(self.repo.iter_commits(max_count=20000))

    def sample(
        self,
        n: int = 50,
        max_per_author: int = 5,
        seed: int = 42,
        min_files_changed: int = 1,
        python_only: bool = True,
    ) -> List[str]:
        """
        分层采样 n 个提交 SHA。

        Args:
            n: 目标采样数量
            max_per_author: 每个作者最多入选几个提交
            seed: 随机种子（保证可复现）
            min_files_changed: 至少变更的文件数（过滤 trivial 提交）
            python_only: 是否只采样包含 .py 文件变更的提交
        """
        random.seed(seed)
        all_commits = self._get_all_commits()

        # ------ 预过滤 ------
        filtered = []
        for c in all_commits:
            if not c.parents:
                continue  # 跳过 root commit
            try:
                changed = list(c.stats.files.keys())
            except Exception:
                continue
            if python_only and not any(f.endswith(".py") for f in changed):
                continue
            if len(changed) < min_files_changed:
                continue
            filtered.append(c)

        if len(filtered) == 0:
            print(f"[CommitSampler] 警告: {self.project_name} 无符合条件的提交")
            return []

        # ------ 分层：按时间三等分 ------
        n_strata = 3
        stratum_size = math.ceil(len(filtered) / n_strata)
        strata = [filtered[i * stratum_size: (i + 1) * stratum_size]
                  for i in range(n_strata)]

        per_stratum = max(1, n // n_strata)
        sampled_shas: List[str] = []
        author_count: Dict[str, int] = {}

        for stratum in strata:
            random.shuffle(stratum)
            count = 0
            for c in stratum:
                if count >= per_stratum:
                    break
                author = str(c.author.email)
                if author_count.get(author, 0) >= max_per_author:
                    continue
                sampled_shas.append(c.hexsha)
                author_count[author] = author_count.get(author, 0) + 1
                count += 1

        # 不足 n 时从剩余随机补充
        if len(sampled_shas) < n:
            remaining = [c.hexsha for c in filtered
                         if c.hexsha not in set(sampled_shas)]
            random.shuffle(remaining)
            sampled_shas.extend(remaining[: n - len(sampled_shas)])

        print(f"[CommitSampler] {self.project_name}: 从 {len(filtered)} 个提交中"
              f"采样 {len(sampled_shas)} 个")
        return sampled_shas[:n]

    def save_batch(
        self,
        commit_shas: List[str],
        output_path: Optional[str] = None,
    ) -> Path:
        """
        保存标注批次为 JSONL（每行一个待标注提交的元数据）。

        每条记录包含：sha、author、date、message、changed_files、diff_stat
        便于标注员在标注工具外预览。
        """
        if output_path is None:
            out = (config.DATA_DIR / "annotations" / "batches"
                   / f"{self.project_name}_batch.jsonl")
        else:
            out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        written = 0
        with open(out, "w", encoding="utf-8") as f:
            for sha in commit_shas:
                try:
                    c = self.repo.commit(sha)
                    changed = list(c.stats.files.keys())
                    record = {
                        "project": self.project_name,
                        "commit_sha": sha,
                        "author_name": c.author.name,
                        "author_email": c.author.email,
                        "date": datetime.utcfromtimestamp(
                            c.committed_date).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "message": c.message.strip()[:300],
                        "changed_files": changed[:20],
                        "total_files_changed": len(changed),
                        "insertions": c.stats.total.get("insertions", 0),
                        "deletions": c.stats.total.get("deletions", 0),
                        "label_source": "human_annotation",
                        "annotation_status": "pending",
                    }
                    f.write(json.dumps(record, ensure_ascii=False) + "\n")
                    written += 1
                except Exception as e:
                    print(f"  [警告] 跳过 {sha[:8]}: {e}")

        print(f"[CommitSampler] 已写入 {written} 条记录 → {out}")
        return out
