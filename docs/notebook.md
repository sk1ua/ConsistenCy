# Repository Review Notebook

The Repository Review Notebook is an evidence-grounded research workspace designed to help developers inspect and explore the architectural impact and risk boundaries of pull requests.

---

## 1. Operating Modes

| Mode | Source Authority | LLM Provider | Side Effects |
|---|---|---|---|
| **Public Read — Anonymous** | Public GitHub REST API & anonymous Git clone | DeepSeek or OpenAI | Creates read-only analysis Job; never publishes comments |
| **Public Read — PAT** | Server-side read-only PAT | DeepSeek or OpenAI | Creates read-only analysis Job; never publishes comments |
| **Webhook Review** | GitHub App installation token | DeepSeek or OpenAI | Evaluates pull request and follows configured publication policy |

---

## 2. Source Boundaries & Provenance

The Notebook binds strictly to an immutable repository snapshot:

$$\text{Source Key} = \text{repository} + \text{pullRequestNumber} + \text{jobId} + \text{baseSha} + \text{headSha}$$

- **Strict Citation**: Citations explicitly record file path, line numbers, head SHA, and verified code excerpts.
- **SHA-Isolated Indices**: Repository AST indices are cached per `repository + headSha`. Working tree modifications or alternate PR branches never collide.

---

## 3. Read-Only Tool Primitives

The Notebook agent operates with strictly limited read capabilities:
- `search_repository`: Structural and text search across the pinned snapshot.
- `read_file`: Line-budgeted file inspection.
- `get_diff` / `get_base_file`: Inspection of PR changes and base file revisions.
- `get_evidence_pack` / `get_review_findings`: Grounded review findings from deterministic analyzers.
- `generate_patch`: Generates suggested unified diff text without filesystem write permissions.

> **Execution Boundary**: The Notebook agent has no shell access, no arbitrary code execution capabilities, no filesystem write privileges, and cannot post comments to GitHub.

---

## 4. Analysis Cards

1. **Change Map**: File and module alteration boundaries.
2. **Architecture Impact**: Evidence-backed explanation of module and dependency shifts.
3. **Risk Brief**: Summary of deterministic risk signals and findings.
4. **Fix Plan**: Prioritized recommendations, testing suggestions, and unapplied diff previews.

When evidence is insufficient, the Notebook explicitly states that the context cannot be verified rather than extrapolating speculative conclusions.
