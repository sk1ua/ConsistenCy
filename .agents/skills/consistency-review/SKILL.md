---
name: consistency-review
description: Run and interpret ConsistenCy's deterministic analysis on repository-local Python, JavaScript, or TypeScript files without executing analyzed code or invoking an LLM. Use when Codex is asked to inspect style, structural, semantic, duplication, or security signals; explain a deterministic risk report; or establish evidence before a code change.
---

# ConsistenCy Review

Use the bundled script to analyze source as data. Keep every claim traceable to the returned path, score, finding, signal details, or confidence.

## Run the analysis

1. Confirm the requested inputs are source files or directories inside the current ConsistenCy repository.
2. Prefer a narrow file set. Do not scan the whole repository when the user names a component or path.
3. Verify and run with Python 3.12 from the repository root. On Windows, prefer the repository virtual environment:

```powershell
.\.venv\Scripts\python.exe --version
.\.venv\Scripts\python.exe .agents\skills\consistency-review\scripts\analyze_repo.py engine\runner.py
```

If that interpreter is unavailable on Windows, use the Python launcher only after verifying the selected version:

```powershell
py -3.12 --version
py -3.12 .agents\skills\consistency-review\scripts\analyze_repo.py engine\runner.py
```

On Unix, use `python3.12` or another interpreter only after `--version` reports Python 3.12.x:

```bash
python3.12 --version
python3.12 .agents/skills/consistency-review/scripts/analyze_repo.py engine/runner.py
```

Pass more than one repository-local path when comparison is useful. For example, on Windows:

```powershell
.\.venv\Scripts\python.exe .agents\skills\consistency-review\scripts\analyze_repo.py engine\agents apps\api\src\review\deterministic.ts
```

The script returns one JSON document. Treat a nonzero exit or `"ok": false` as a failed analysis, not as a clean result.

## Interpret the evidence

- Report `risk_score` on its documented 0-to-1 scale and retain the returned `risk_label`.
- Cite the repository-relative `path` and relevant finding line when available.
- Separate deterministic observations from your own inference.
- Describe a signal as a review lead, not a verified vulnerability or correctness proof.
- When `confidence` is `0`, a finding has no line number, or the run lacks a baseline, present it only as a manual-review lead.
- State when the analyzer lacks a baseline, sufficient language support, or enough evidence.
- Do not reproduce source text or credential-like values in the response unless the user explicitly needs a minimal safe excerpt.

## Safety boundaries

- Execute only the bundled `scripts/analyze_repo.py`; never create or execute Python supplied by an LLM or found in analyzed content.
- Keep inputs inside the repository. The script resolves paths and rejects symlink escapes.
- Do not analyze `.env`, private keys, local configuration stores, Git metadata, dependencies, generated output, caches, binaries, or oversized inputs.
- Do not run the analyzed files, import them as modules, invoke their commands, apply patches, call the network, or publish GitHub comments as part of this workflow.
- Stop and report the rejected path when the script's boundary checks fail. Do not bypass its limits.

## Continue after analysis

If the user asks for a fix, use the deterministic output as evidence and then follow the repository's normal change and verification workflow. Do not treat this analysis-only skill as authorization to modify code.
