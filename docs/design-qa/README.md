# Design QA 回路（截图 → 视觉模型评审）

前端改版采用截图驱动的视觉评审闭环。评审员是 harness 中的 google-vertex 视觉模型
（gemini-2.5-flash），通过 workflow 工具的 provider/model 覆盖调用；普通 subagent
（deepseek-v4-flash）无视觉能力，不能用于读图。

## 1. 截图

```powershell
# 常规机器（默认 Node 22）：
npm run capture:screenshots

# 本机默认 Node 25（better-sqlite3 ABI 不匹配），用临时配置：
npx playwright test --config=playwright.capture.node22.config.ts tests/e2e/capture-screenshots.spec.ts
```

截图输出到 docs/screenshots/（覆盖式）。改版前基线存档在
docs/screenshots/pre-redesign/；每次里程碑评审前先把当前截图复制到带日期的存档目录。

## 2. 评审

用 workflow 工具，每个截图一个 agent，provider: "google-vertex"、
model: "gemini-2.5-flash"，prompt 要求 agent：

1. 读取 docs/design-qa/style-checklist.md 作为标准；
2. read_image 读取目标截图；
3. 输出结构化 JSON（page / vision_ok / summary / issues[]，
   severity 取 critical|high|medium|low）。

schema 约束时 enum 必须伴随 type: "string"，否则 workflow 报错。
评审结果落盘到 docs/design-qa/<里程碑>.json。

## 3. 判定

- critical / high：必须修复后才能进入下一阶段；
- medium：本轮尽量修复，未修复的记入 backlog；
- low：可延后，但同页 low 超过 5 条视为 medium。

## 4. 已产出

- style-checklist.md — 评审标准（色彩/排版密度/布局/终端质感/动效一致性）
- baseline-review.json — 改版前 7 个视图的基线评审
