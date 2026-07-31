# ConsistenCy V2 Phase 6 最终门禁审计报告

## 结论

**Phase 6 暂不批准，仅剩 1 项 P1 测试隔离问题。**

本轮其余整改均已独立验证通过：

- editable metadata 成功生成；
- V2 demo 输出正确摘要；
- ablation 入口可运行；
- Ruff 通过；
- Python 116 项测试通过；
- TypeScript typecheck 通过；
- `git diff --check` 通过。

但是全量 `npm test` 未通过，附件中的 147/147 结果在当前工作区不可复现。

---

## P1：Cleanup gate 扫描了 `.gitignore` 中的本地生成报告

- **文件**：`apps/api/src/config/cleanup.test.ts`
- **位置**：`getAllSourceFiles()` 与 `targetDirs`
- **失败测试**：`verifies zero non-historical references to legacy V1 patterns remain`

### 独立失败证据

```text
npm test

FAIL src/config/cleanup.test.ts

evaluation/results/ai_review_test.json:
  contains pattern "backend/cli.py"
  contains pattern "backend/src"

evaluation/results/smoke_report.json:
  contains pattern "backend/cli.py"
  contains pattern "backend/src"
```

Git 已明确确认这些文件是忽略的生成物：

```text
.gitignore:54:evaluation/results/
```

`evaluation/results/` 保存用户本地生成或下载的历史评估报告。它不属于当前仓库源码，内容也可能合法记录历史提交中的 V1 路径。Cleanup gate 不应让测试结果取决于开发者本机是否保留这些报告。

### 禁止的修复

不要为了让测试通过而删除 `evaluation/results/`。这些文件被 Git 忽略，可能是用户生成的数据；Phase 6 没有获得删除用户评估结果的授权。

不要恢复为“不扫描任何 JSON”，否则会重新漏过 tracked manifest/config。

### 确定修复

使用路径级的生成目录排除，而不是按任意目录名排除：

```ts
const GENERATED_CONTENT_DIRS = [
  resolve(ROOT, "evaluation/repos"),
  resolve(ROOT, "evaluation/results"),
  resolve(ROOT, "evaluation/data")
];

function isInsideGeneratedContent(path: string): boolean {
  const absolute = resolve(path);
  return GENERATED_CONTENT_DIRS.some(
    (root) => absolute === root || absolute.startsWith(`${root}${sep}`)
  );
}

function getAllSourceFiles(dir: string): string[] {
  if (isInsideGeneratedContent(dir)) return [];
  // existing traversal
}
```

需从 `node:path` 增加 `sep` import：

```ts
import { join, resolve, sep } from "node:path";
```

保留当前扩展名范围：

```ts
/\.(ts|tsx|py|yml|yaml|md|json|toml|txt)$/
```

这样仍会扫描 tracked JSON/TOML/TXT，只排除 `.gitignore` 定义的本地 evaluation 工作区。

### 必须新增的断言

在组成 `allFiles` 后断言：

```ts
expect(
  allFiles.some((path) => isInsideGeneratedContent(path))
).toBe(false);
```

并继续保留：

```ts
expect(existsSync(resolve(ROOT, "evaluation/smoke_manifest.json"))).toBe(false);
```

### 验收

在 `evaluation/results/` 保留当前本地 JSON 文件的情况下运行：

```text
npm test
```

必须达到：

- API 127/127；
- Web 6/6；
- Schema 14/14；
- 总计 147/147。

然后执行：

```text
npm run build
git diff --check
```

全部通过后可直接批准 Phase 6，并将 task/master plan 状态更新为 `APPROVED & COMPLETE`。`requirements-lock.txt` 仍按既定边界留给 Phase 7 的 Python 3.12 环境重建。
