# ConsistenCy v3 审计修复进度

修复依据：《ConsistenCy-v3-architecture-audit》（2026-09-13，基准提交 `78dc904f522ec3e31d7ef70ae7a940880d4078e5`）。

**基座状态（2026-09-19 更新）：** 本仓库 HEAD 已随 `git pull` 快进至 `e58ecb2`（owner 于 08-24→09-18 自主合入 PR #37–#53，远端不含本文件记录的审计修复内容）；第一阶段改动以未提交工作树形式迁移到新基座（唯一冲突 `ReportPage.tsx` 已合并：degraded 警告优先、正常路径并入上游 "All findings dismissed" 状态；`jobDiff.ts`/`report.css` 自动合并）。迁移后验证：`npm ci` + `typecheck` 全绿 + 定向 19 测试（ReportPage 4 / jobDiff 6 / content-policy 9）全过。

**证据边界（重要）：** 原审计报告文件（owner Temp 目录）已不可寻回。本文件中第一阶段的逐项描述是报告原文结论在 2026-09-14 的冻结转写；「剩余断点」中各阶段条目仅有短标题（工作树损坏前所留），其中 P2-03 在冻结摘要中无对应描述，标为**依据不足**。剩余项的现状一律以当前代码逐项重核为准（见 `docs/delivery-readiness.md` 现状矩阵），不将摘要重建冒称原报告全文。

- 复核方法：沿真实生产调用链读源码确认（入口 → context builder → ReviewWorkload → prompts → provider driver；jobDiff resolver；runtime snapshot API → RuntimePanel）。
- 状态图例：✅ 已修复（生产路径使用新实现 + 定向回归测试 + 验证通过）｜🔧 修复中｜⏳ 待处理。
- 验证环境：Windows / Node 22.23.2（pinned portable）/ vitest 定向套件。

---

## 第一阶段：输入安全与结果真实性

### P0-01 — Snapshot 原文覆盖已过滤 context ✅

**复核结论：属实，且比报告更宽。** 报告指出 `ReviewWorkload.run`（`packages/workload-review/src/workload/review-workload.ts` 原 L156-170）对每个非 removed changed file 用 `snapshot.readFile()` 原文覆盖 `context.fileContents`。复核另发现三条同源泄漏路径，报告未显式列出但同样到达模型输入：

1. `context.diff`：`buildLocalContext`/`buildPRContext` 由 git hunks 拼出，从未脱敏，直接进入 `buildAgentPrompt` 的 `DIFF` 段与 Supervisor prompt 的 `Diff excerpt` 段。
2. `changedFiles[].patch`：原始 patch 全文。
3. `baseFileContents`：`git show` 原文（仅跳过 secret 路径，无文本脱敏）。

即：即使没有 snapshot 覆盖，diff 路径也会把 loader 已遮盖的 token 重新送入模型。

**生产调用链：** `POST /reviews/local → triggerLocalReview → ReviewWorker.execute → buildLocalContext → loadWorkspaceFiles（isSecretPath 跳过 + redactSensitiveText）→ createReviewRuntime.run → RepositorySnapshot.create → ReviewWorkload.run（snapshot 原文覆盖）→ buildAgentPrompt → CapabilityBoundLLMFacade → provider`。

**修复（区分分析原始内容与模型可见内容）：**

- 新增 `packages/schema/src/content.ts`：canonical `isSecretPath`（fileLoader 原实现上移，单一实现；fileLoader 改为 re-export，notebook indexer / patchPolicy / PR·local builder 的既有 import 不变）。
- 新增 `packages/workload-review/src/context/content-policy.ts`：
  - `redactModelVisibleText`：行数保持（含 PEM 块逐行替换，grounding 行号不受影响）、幂等；模式为 apps/api loader 脱敏 + plugins-builtin 摘要脱敏的超集（GitHub/ghs token、`sk-` key、AWS AKIA、Bearer/Authorization、URL 凭证、key=value 赋值、私钥块）。
  - `applyModelContentPolicy(context)`：模型可见投影——secret 路径的 fileContents/baseFileContents/projectMetadata 条目整体丢弃（changedFiles 保留路径名，让 Security agent 仍能指出"提交了 .env"，但 patch 移除）；diff/patch/其余文本全部脱敏。
- `review-workload.ts`：拆分双视图——`analysisContext`（原始字节，喂 DeterministicEvidenceRunner + Python 确定性阶段 + relevantContext 本地富化，秘密检测与证据完整性不破坏）与 `agentContext`（`applyModelContentPolicy` 投影，供 Supervisor/specialists/Synthesizer/grounding）。snapshot 原文从此只能进入分析视图。
- 纵深防御：`buildAgentPrompt` / Supervisor `invokeStructured` / Synthesizer `invokeText` 的最终 userPrompt 再过一次 `redactModelVisibleText`（覆盖 analyzer 字符串、历史富化、planner 输出等未来旁路）。

**回归测试：**
- `packages/workload-review/src/__tests__/content-policy.test.ts`（新增）：secret 路径丢弃、全文本面脱敏、行数保持、幂等、不改写输入 context。
- `review-workload.test.ts` 新增 "model content policy"：真实 fixture（HEAD 文件 + diff 含合成 `FAKE_TOKEN`，snapshot 原文同样含）跑完整 workload，断言 TestModelDriver 捕获的每一次模型请求（system+user prompt）均不含 token；同批断言 evidence 仍含 `secret.github-token`/`style.trailing-whitespace`（证明本地分析仍见原始字节）。

**遗留与边界：** VM（ContextImage 的 source/diff 页）本批仍持原始内容——VM 当前不构造模型输入（报告 C3/P1-03，第四阶段接线时该策略模块即为其唯一出口）。`apps/api/security/redact.ts`（HTTP/日志脱敏）职责不同，保持独立。

**2026-09-19 增补（P0-01 复核缺口，监督发现）：** 第一阶段曾注明「diff 中 secret 路径文件只做值脱敏不做 hunk 丢弃」——该决策被推翻：`context.diff` 是预拼接字符串，只做正则脱敏时，`.env` 内不匹配任何 token 正则的自定义值（如 `INTERNAL_SERVICE_TICKET=qq-771234`）仍会经 DIFF prompt 段进入模型。原 content-policy 测试的 `.env` fixture 只覆盖 changedFiles.patch 路径，合并 diff 中无秘密段，旁路未被覆盖。
**修复：** `content-policy.ts` 新增 `dropSecretPathDiffSections`——把统一 diff 解析为按文件分段（兼容 GitHub `diff --git` 与本地构造器 `--- a/x`/`+++ b/x` 两种头格式，含 rename 的 previousPath 与 `/dev/null` 侧），秘密路径整段删除后原样重组；歧义头形内容行（如 hunk 内删除行 `-- a/.env` 后随 `++ b/x`）解析方向取删除（fail-closed 过度脱敏，绝不漏）。`applyModelContentPolicy.diff = redactModelVisibleText(dropSecretPathDiffSections(diff))`。
**证据（红→绿）：** 复现日志 `.omo/evidence/delivery-batch1/p0-01b-reproduce-red.log`（exit 1：完整 workload 捕获的模型 userPrompt 中出现 `+ADDED_SETTING=gamma`——该赋值名不匹配任何脱敏正则）；修复后 `.omo/evidence/delivery-batch1/p0-01b-fixed-green.log`（exit 0，35/35）。新增用例：本地格式混合 diff（普通+新增/删除秘密+类头内容行不误切）、git 格式（含 `.env.staging→config/runtime.conf` 改名经 previousPath 删除、普通改名保留）、正常段内 token 仍脱敏、幂等、不改写输入；workload 级「秘密 diff 段不进任何模型请求」断言。本地原始分析仍见原始字节（既有 RAW snapshot 断言保持通过）。

### P1-05 — specialized agents 全失败被顶层 success 掩盖 ✅

**复核结论：属实。** `runReviewAgentBody` 捕获模型错误返回空 findings；`ReviewWorkload.run` 仅 push `errors[]`，继续合成报告并无条件 `succeedRun`；报告 schema 无覆盖度字段；Synthesizer 在 findings=0 时输出 "No confirmed issues were identified..."——全 specialists 失败的 run 呈现为"干净通过"。

**修复（区分 执行完成 / 覆盖完整 / 部分失败 / 无发现）：**

- `packages/schema/src/report.ts` 新增 `reviewCoverageSchema`（`outcome: complete|degraded`、`enabledAgents`、`failedAgents`、`plannerFailed`、`synthesizerFailed`），`reviewReportSchema.coverage` 可选（旧报告兼容解析）。
- `review-workload.ts` 统计失败 specialists（含未被调度器 admit 的），连同 planner 失败状态传入 Synthesizer。
- Synthesizer 终算 coverage（含自身 summary 失败），写入报告；degraded 时摘要前缀确定性警告（中/英，按 reportLanguage），LLM 摘要不可伪造"干净"结论；findings=0 且 degraded 的 fallback 文案明确"不代表审查通过"。
- Job 语义：执行完成仍产出报告、job 仍 `succeeded`（不把非关键失败升级为整 job 失败）；覆盖度经 `jobStore.result → toApiJob → /reports` 自动到达 UI。
- UI（`apps/web/src/pages/ReportPage.tsx` + `report.css`）：degraded 横幅（warning 色、role=status、双语）；findings=0 且 degraded 时空状态文案改为"有代理失败，不代表通过"。

**回归测试：** `review-workload.test.ts` 新增 3 例：5/5 启用 specialists 全失败 → run SUCCEEDED + 报告产出，但 `coverage.outcome=degraded`、`failedAgents=5`、摘要含 "coverage incomplete" 且不含 "No confirmed issues"；正常成功 run → `complete`；planner 失败 → 兜底计划（6 agents）+ `plannerFailed=true` + degraded。

**遗留：** jobs 列表页未加 degraded 徽标（报告页已可见；Findings 页聚合展示属第五阶段 UI 收敛范围）。

### P1-11 — 生产 diff resolver 的 demo 合成分支 ✅

**复核结论：属实。** `apps/api/src/review/jobDiff.ts` 原 L54-94：workspace 不存在且 job 带 demo 标识（`deliveryId manual:demo:*` / `senderLogin "demo"` / `id job_demo*`）时返回硬编码合成 diff（http.ts / RuntimePanel.tsx 两个文件）。生产模块、生产函数、无测试专用隔离。demo 种子数据本身已在历史迁移中清除（`db/migrations.ts` 删除 demo jobs），前端 `job_demo` 判断仅为旧数据展示启发。

**修复：** 删除整个合成分支——workspace 缺失一律 `{files: [], available: false}`（UI Diff 页既有 unavailable 展示）。不迁移 fixture：无任何测试依赖该分支（`jobDiff.test.ts` 的 cleaned-up 用例本来就断言 unavailable）。

**回归测试：** `jobDiff.test.ts` 新增：带全部 demo 标识的 job + 无 workspace → unavailable，永不返回合成 diff。

### P1-08 — in-process runtime 谎报 enforced 隔离 ✅

**复核结论：属实。** `packages/schema/src/runtime.ts` `DEFAULT_SECURITY_GUARANTEES` 将 processMemoryIsolation/parentEnvSecretIsolation/kernelRpcAuthorization 默认标 `enforced`；`buildRunRuntimeSnapshot`（harness-core）无人传该 option 时直接采用默认；生产 Review agents 全部 `executionDomain: "in-process"`；http.ts 的 unavailable-job fallback 同样输出该默认。

**修复（安全状态来自真实启用的执行与防护机制）：**

- `observability.ts` 新增 `deriveSecurityGuarantees(agents, sandboxSessions)`：
  - `processMemoryIsolation`: 仅当 run 内**所有** agent 为 `child-process`（≥1 个）才 enforced；in-process/worker-thread/无 agent → not-enforced。
  - `parentEnvSecretIsolation` / `kernelRpcAuthorization`: 在上者基础上还要求每个 agent 有匹配的 sandbox session（沙箱桥是环境过滤与 RPC 鉴权的实际执行者；裸 executionDomain 标签不构成证据）。
  - OS containment 三项恒 not-enforced。
  - 显式传入 option 仍可覆盖（宿主自证场景）。
- `DEFAULT_SECURITY_GUARANTEES` 改为全 not-enforced（诚实地板值，供无证据场景）。
- 更新 `taskManager.test.ts` AC-TM-16：in-process → 全 not-enforced；无 agent → not-enforced；child-process 无沙箱 → 仅 process 隔离 enforced；child-process + 沙箱 session → 三项 enforced。原断言把默认谎言固化在测试里，属于本项修复对象本身。

### P2-02 — Synthesizer telemetry 重复 ✅

**复核结论：属实。** `review-workload.ts` 的 persistence wrapper 把每次 `saveAgentRun` push 进 workload 本地 `agentRuns`；`runSynthesizerBody` 在 `persistence.saveAgentRun(run)` **之后**调用 `buildReviewReport({agentRuns: [...options.agentRuns, run]})`——同一数组已含该 run，报告里 Synthesizer 出现 2 次、库中 1 次。

**修复：** Synthesizer 在调用 `saveAgentRun` 前快照 `agentRunsForReport = [...options.agentRuns, run]`，报告与持久化各恰好一条。

**回归测试：** `review-workload.test.ts`：报告与 TestPersistence 中 Synthesizer 各 1 条、ID 相同；报告 agentRuns 与持久化 agentRuns 的 ID 集合完全一致。

---

## 第二阶段（2026-09-19 批次一）：快照身份与恢复

### P1-01 — 工作树审查快照身份与持久化 ✅（本批）

**复核结论（e58ecb2 基座重核）：** 属实。工作树审查入队时 `headSha=WORKING_TREE`（符号值），执行时活读工作盘（`buildLocalContext` 不克隆，`workspacePath=repoPath`），`baseSha` 执行时重新 rev-parse——入队后开发者再提交即与 job.baseSha 分叉；`jobDiff` 对工作树 job 每次请求重新 `collectWorkingTreeChanges` 活读当前工作树，与报告捕获的 diff 之间无一致性保证；`RepositorySnapshot.create` 对符号 SHA 必然失败走 `contentBackedSnapshot` 内存回退，重启后不可复现。最近 41 个远端提交（untracked 并入变更面、jobDiff 复用 collect）统一了判定面但把两处都钉死在"调用时刻的工作树"，未引入任何快照身份。

**修复（审查时快照 + 耐久解析 + 诚实降级）：**

- `packages/schema/src/context.ts` 新增 `reviewSnapshotSchema`（jobId/baseSha/headSha/files:VcsChangedFile[]/capturedAt）。
- 迁移 `0023_job_review_snapshots`（SQLite 表，FK→jobs ON DELETE CASCADE）。
- `buildLocalContext` 返回 `{ context, changedSurface }`（原始 VcsChangedFile[] 与 diff 同源同刻捕获，无双读漂移）；`contextRouter` 新增 `onWorkingTreeSurface` 钩子——仅工作树审查触发（range/GitHub 已有 SHA 身份不触发），server 接线 `jobs.saveReviewSnapshot`（执行前落库，失败的 run 也钉住其尝试审查的面）。
- `ReviewJobStore` 新增 `saveReviewSnapshot`/`getReviewSnapshot`（SQLite 严格 schema 往返 + 损坏行按缺失降级；内存实现同步补齐）。
- `resolveJobDiff`：工作树 job 快照优先（`pinned:true`）；无快照的旧 job 回退活读并 `pinned:false`（UI 显示「差异未钉住·可能与审查内容不一致」横幅，诚实披露漂移而非假装一致）；range/克隆工作区 job 恒 `pinned:true`。`jobDiffResponseSchema` 增 `pinned`（default false）。
- store 接口另增 `failInterruptedRunningJobs`（见 P1-07②）。

**回归证据（监督指定场景）：** `apps/api/src/review/jobSnapshotPersistence.test.ts`——真实 git 仓库上构造 staged+unstaged+untracked+删除+git mv 改名+`.consistencyignore` 排除+修改型秘密路径（`.env.production` 含非正则自定义值）的审查面；随后提交全部改动并再次改写工作树（dirty.ts 三改、删除 fresh.ts、新增 late.ts）；以**同库新开 store 实例模拟重启**；断言旧 job diff 与审查时快照逐字节相等（五类变更、rename previousPath、审查时 hunk 内容保留、漂移内容不出现、finding 行号仍落入持久 hunk 区间）；新审查捕获新内容；秘密路径经 `applyModelContentPolicy` 后整段不进模型 diff（与 P0-01 增补联动断言）；排除文件全程不入面。另有 legacy 无快照回退（pinned:false）与 range SHA 钉住（pinned:true）用例。日志 `.omo/evidence/delivery-batch1/p1-01-snapshot-green.log`（exit 0，18/18）。

### P1-07② — 重启恢复盲区（15 分钟窗口孤儿 job）✅（本批）

**复核结论：** 属实。启动恢复仅 `server.ts` 一处单次调用 `recoverStaleRunningJobs(now-15min)`；崩溃前 15 分钟内启动的 running job 重启后无 worker 认领、无周期扫描，永久卡 running。workflow-runtime（无条件 fail 所有中断 run）与 audit executor（reconcileInterruptedRuns）均已做到无条件收敛，唯独 review job 留有窗口。

**修复：** `ReviewJobStore.failInterruptedRunningJobs()`（SQLite+内存实现）——启动时把所有 running 置 failed、error="Job interrupted by API restart"（与 workflow-runtime 措辞对齐；review job 全部进程内执行，重启即孤儿，无合法存活 running）。server.ts 启动改用之；`recoverStaleRunningJobs` 保留（15 分钟超时语义对将来的周期扫描仍有用，其既有测试不动）。

**回归证据：** `sqliteJobStore.test.ts` 新增（新近 running + 旧 running 均 fail、queued 不动）；`jobQueue.test.ts` 内存实现同语义。日志 `.omo/evidence/delivery-batch1/p1-07b-recovery-green.log`（exit 0，14/14）。

---

## 验证记录

环境：Node v22.23.2（pinned portable）、Python 3.12.10（`.\.venv\Scripts\python.exe`）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（全 workspace） | ✅ 0 错误 |
| `npm run verify:runtime`（`CONSISTENCY_PYTHON_PATH` 指向 .venv） | ✅ Node v22.23.2 + Python 3.12.10 |
| `npm run verify:docs` | ✅ 45 个 Markdown 文件 |
| `packages/workload-review` vitest（含新增 content-policy.test.ts + 7 个回归用例） | ✅ 4 files / 36 tests |
| P0-01 红绿验证：临时回退 `applyModelContentPolicy` → 测试红（1 failed）；恢复 → 20/20 绿 | ✅ 测试确能捕获回归 |
| `packages/schema` vitest | ✅ 8 files / 87 tests |
| `packages/harness-core` vitest（含改写的 AC-TM-16） | ✅ 3 files / 11 tests |
| `apps/api` vitest 全量 | ✅ 76 files / 741 tests |
| `apps/web` vitest 全量（含新增 degraded 横幅用例） | ✅ 46 files / 367 tests |

## 未运行与原因

- 未调用真实 LLM / 未发布 GitHub 评论 / 未 push（禁止事项；离线 fake provider 覆盖本批全部断言，真实模型属收尾阶段另行复核）。
- `pytest`：engine/ 无改动，跳过。
- `npm run build` / `test:desktop` / E2E：本批未触碰构建与桌面链路，留待阶段收尾统一跑。

## 2026-09-19 批次一验证记录

环境：Node v22.23.2（pinned portable）；日志目录 `.omo/evidence/delivery-batch1/`。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npx vitest run`（content-policy + review-workload，修复前） | ❌ exit 1，3 例失败——完整 workload 模型请求中复现秘密 diff 段泄漏 | `p0-01b-reproduce-red.log` |
| `npx vitest run`（同上，修复后） | ✅ exit 0，35/35 | `p0-01b-fixed-green.log` |
| `npx vitest run`（sqliteJobStore + jobQueue） | ✅ exit 0，14/14 | `p1-07b-recovery-green.log` |
| `npx vitest run`（jobSnapshotPersistence + jobDiff + jobDiff.route + buildLocalContext） | ✅ exit 0，18/18 | `p1-01-snapshot-green.log` |
| `npm run typecheck`（全 workspace） | ✅ exit 0 | `batch1-typecheck.log` |
| `npx vitest run packages/schema apps/api`（全量） | ✅ exit 0，858/858 | `batch1-api-schema-suite.log` |
| `npx vitest run`（useJobDiff + ReportRoute + ReportPage + workload-review 全量） | ✅ exit 0，59/59 | `batch1-web-wl-suite.log` |
| `npm run verify:docs` | ✅ exit 0，48 个 Markdown | `batch1-verify-docs.log` |

批次一未运行项（留待交付收尾统一跑，见 `docs/delivery-readiness.md`）：`npm run build`、`npm test` 全仓聚合、`test:desktop`、e2e、`pytest`、`verify:runtime`。

## 批次一自审记录（2026-09-20，自审者=实现方，独立于实现时验证）

对批次一全部改动做批判性重读，发现并修复三处：

- **S1（语义缺陷）**：`dropSecretPathDiffSections` 对删除文件段（`+++ /dev/null`）会把 `previousPath` 错设为与 resolved path 相同的值（三处同病）。修复=`resolveSectionPaths` 统一解析（previousPath 仅在确有差异时记录）。
- **S2（泄漏向风险）**：正则不容忍 CRLF 行尾——路径捕获会吞 `\r` 使 `isSecretPath("x\r")` 不命中，秘密段不删（fail-open）。生产 diff 虽为 LF，但该方向的失败不可接受。修复=三个头正则加 `\r?` 容忍。
- **S9（文档性）**：快照钩子"抛错即整体失败"是有意设计但代码未写明，补注释。

新增回归用例：CRLF diff 秘密段删除、删除文件段按旧侧路径识别且不虚构 previousPath。验证：`.omo/evidence/delivery-batch1/batch1-selfreview-fixes.log`（exit 0，19/19）。

## 第二阶段续（2026-09-20 批次二）：证据链耐久

### P1-06① — 默认 workflow 路径保留 evidencePack ✅（本批）

**修复：** `workflowAdapter.ts` 新增 `evidencePackFromRun`——workflow artifacts 的证据按文件组装成引擎 `RetrievalTrace` 同形结构（candidate.content=excerpt、start_line/end_line、risk_terms=规则集、query.metadata 带 workflow/runId 溯源、strategy=`workflow:<spec>`、context_budget_tokens=0 诚实值），`workflowRunToAnalyzeResult` 返回 `evidencePack`。默认（非 legacy）审查的报告从此带 `retrieval`，证据卡渲染、Notebook `getEvidencePack` 不再拿占位对象。无证据的 run 仍返回 undefined（诚实空态）。

**回归证据：** `workflowAdapter.test.ts` 新增 2 例（证据入 trace + 结构/summary 断言；失败步骤证据不入、空 run 无 trace）。

### P1-04 — evidence 记录随报告持久化（耐久 resolver）✅（本批）

**修复：** `reviewReportSchema` 新增可选 `evidence: ReviewEvidenceRecord[]`（id/source/ruleId/location/confidence/payload/provenance/fingerprint，strict）；`review-workload.ts` 在跨持久化边界前把 `evidenceStore.list()` 全量投影进报告（`toDurableEvidenceRecord`，非对象 payload 省略不阻塞持久化），持久化与返回的都是同一份 durable 报告。findings 的 `evidenceIds` 从此在报告 JSON 内自含可解——重启、进程换代后 store 按原 schema 反序列化即可解析，无需进程内 EvidenceStore。

**回归证据：** `review-workload.test.ts` 新增——报告 evidence 含 `secret.github-token`；持久化副本与返回副本 id 集合一致；serialize→`reviewReportSchema.parse` 往返后所有 finding.evidenceIds 均可解析。

### P1-06③ — Notebook 接审查快照 ✅（本批，边界如实注明）

**修复：**
- 迁移 `0024_review_snapshot_contents`：快照表增 `contents_json`（context loader 已脱敏、秘密路径已排除的 fileContents 投影——无原始凭据入库）；schema/store/hook 全链传递。
- `selectNotebookSources` 为工作树 job 附带 `reviewSnapshot`；`readRepositoryFile`/`searchRepository` 对快照覆盖的文件返回**审查时内容**（其余仍按索引工作区读取）。
- `getDiff`：工作树 job 从快照渲染审查时 diff（此前直接 `INVALID_SHA` 拒绝）；range job 从两点 `base..head` 改为三点 merge-base `base...head`——与审查本身及 Diff 视图同一语义，同一 job 两处不再显示不同 diff。
- 无快照的旧工作树 job：`SNAPSHOT_NOT_CAPTURED` 诚实错误（不伪造）。

**诚实边界（未声称解决）：** 索引 manifest 仍是扫描时刻快照（未变文件在 HEAD 推进后按活磁盘读，属部分一致）；`getBaseFile` 仍按 base SHA git-show（快照未存 base 内容）。这两点列入后续批次清单。

**回归证据：** `notebook.test.ts` 新增 2 例（漂移后 readRepositoryFile/getDiff 返回审查时内容、post-review 内容不出现；三分支仓库 getDiff 只含 head 侧变更）；`jobSnapshotPersistence.test.ts` 扩展（fileContents 含审查时内容、秘密路径与删除文件不入库、重启后仍在）。

## 批次二验证记录

环境：Node v22.23.2（pinned portable）；日志目录 `.omo/evidence/delivery-batch2/`。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npx vitest run`（notebook + workflowAdapter + jobSnapshotPersistence + review-workload，定向） | ✅ exit 0，42/42 | `b2-suites.log` |
| `npm run typecheck`（全 workspace） | ✅ exit 0 | `b2-typecheck.log` |
| `npx vitest run packages/schema apps/api packages/workload-review`（全量） | ✅ exit 0，907/907 | `b2-api-schema-wl-suite.log` |
| `npx vitest run`（ReportPage + ReportRoute） | ✅ exit 0，14/14 | `b2-web-suite.log` |

未运行项同批次一（收尾统一跑，见 `docs/delivery-readiness.md`）。

## 第三阶段（2026-09-20 批次三）：取消、关停与终态撤权

### P1-07① — 取消贯通外部调用 ✅（本批）

**修复（四层贯通）：**
1. **workload**：`ReviewWorkload` 持 run 级 `AbortController`；`cancelRun()` 同时 `scheduler.cancelRun`（停后续准入）与 `abort()`（中断在飞调用）；`#backend()` 给每次模型派发注入 signal（agent 不可见不可伪造）；run 前取消在入口即拒（不会退化成全 agent 失败的"成功"报告）；取消以类型化 `ReviewCancelledError` 上浮（原"cancelled before synthesis"消息保留），worker 据此保持 job `cancelled` 状态不被改写为 failed。
2. **provider**：`StructuredInvocation`/`FindingGenerationRequest`/summary 请求增 `signal`；`BaseLLMProvider` 派发前后检查中止且**中止不消耗修复重试**；`PiRuntimeProvider.complete` 把 signal 传入 Pi `completeSimple`（Pi `ProviderRequestOptions` 原生支持，传输级真中断），中止错误原样上浮不被泛化掩埋。
3. **registry**：`LiveRunRegistration.requestCancel` 钩子 + `requestCancelByJob(jobId)`（有 workload 钩子走钩子、无则回退 scheduler.cancelRun、无 live run 返回 false）+ `requestCancelAll()`（关停用）。
4. **API**：`POST /jobs/:id/cancel`（`cancelReviewJob`：404 未知 / 409 终态（含发布中）/ 200 取消——先通知 live run 再落库）。

**回归证据：** `review-workload.test.ts` 4 例（在飞调用收到真实 abort、后续 agent 零调用、run CANCELLED 非 FAILED、取消路径撤权；run 前取消不产报告；成功路径全撤；持久化 sink 失败路径撤权）；`jobCancel.test.ts` 5 例（queued/running+live 信号/404/409 + HTTP 200/409/404）；`worker.test.ts` 取消守卫（cancelled 不被改写为 failed）；`taskManager.test.ts` registry 2 例。

**诚实边界：** Web UI 取消按钮未做（API 完备，属批次五 UX 收敛）；Pi 传输级中断为代码级接线 + 离线验证，真实网络下行为属收尾真实 LLM 流程走查范围。

### P1-07③ — shutdown 截止 ✅（本批）

**修复：** `ReviewWorker.stop({ms, onExpiry})`——宽限窗口到期触发 onExpiry（server 侧 `runtimeRegistry.requestCancelAll()` 中断全部在飞调用），再等同宽第二窗口后**放弃返回**（不再无限期陪跑）；循环加代际守卫（被放弃的循环不会在 start() 复用后双跑）。`server.ts` 关停接线 + `CONSISTENCY_SHUTDOWN_GRACE_MS`（默认 30s，1s–600s）。

**回归证据：** `worker.test.ts`（300ms 挂起 job + 50ms 宽限 → onExpiry 恰一次、stop 在 <300ms 返回、job 事后收敛为 failed；无在飞时立即返回不触发 onExpiry）。

### P1-02 — capability 终态撤权 ✅（本批）

**修复：** `ReviewWorkload` 记录全部签发 handle（`#issuedCount` 计数稳定）；`#revokeIssuedCapabilities()` 在**成功、失败、取消**三条终态路径全量 revoke（幂等，失败重抛原错误）；`ReviewWorkloadResult.capabilitiesIssued/Revoked` 透明可断言。

**回归证据：** 成功路径 `revoked === issued > 0`；持久化 sink 失败（签发后失败）撤权 > 0；取消路径撤权 > 0。

### 批次三自审记录（审查者=实现方，修正三处后才全绿）

- **A1（测试期回归，已修）**：catch 无条件把取消路径错误重包装为泛化 ReviewCancelledError，覆盖了既有 AC-REV-13 断言的"cancelled before synthesis"消息——改为已是取消错误则原样重抛（消息保留、类型升级）。
- **A2（语义 bug，已修）**：`stop()` 末尾无条件 `await loop` 使"放弃等待"失效（实测 301ms 才返回而非 ~100ms）——第二窗口也超时则立即返回，循环留_DETACHED_由其自身错误路径收敛。
- **A3（计数失真，已修）**：`capabilitiesIssued` 用 splice 后数组长度推导，个别 revoke 抛错时误报——改为独立计数器。另加 worker 循环代际守卫防 start() 复用双跑。

## 批次三验证记录

环境：Node v22.23.2（pinned portable）；日志目录 `.omo/evidence/delivery-batch3/`。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck`（全 workspace） | ✅ exit 0 | `b3-typecheck.log` |
| `npx vitest run packages/schema apps/api packages/workload-review packages/kernel packages/harness-core`（全量） | ✅ exit 0，1111/1111 | `b3-full-suite.log` |
| 自审修复后复跑（workload-review 全量 + worker/jobCancel/taskManager） | ✅ exit 0，72/72 | `b3-selfreview-fixes.log` |
| `npm run verify:docs` | ✅ exit 0，48 个 Markdown | —（终端确认） |

未运行项同批次一（收尾统一跑，见 `docs/delivery-readiness.md`）。

## 第四阶段（2026-09-21 批次四）：Notebook/Copilot 模型入口

### P1-03 — Notebook/Copilot 模型可见内容 ✅（本批，VM 旁路仍注明）

**修复：** 新增 `apps/api/src/review/llm/hostInvoke.ts`——Notebook 与 Copilot 共用 `hostVisiblePrompt`（`redactModelVisibleText`，与 review workload 同一策略）。`NotebookGraph` 的 stream/summary 不再直送仓库原文；Copilot 的 user/system prompt 同样过该入口。Review 三条 prompt 路径仍走 `applyModelContentPolicy`（一批已完成）。

**诚实边界：** ContextVM source/diff 页仍持原文，但当前无 prompt 出口（`review-context.ts`），不是模型输入路径。未把 VM 改成唯一出口——现有生产模型入口已全部过策略。

### P2-04 — 模型入口记账 ✅（本批）

**修复：** review `llm.invoke` 签发带 `{ maxTokens: 250_000, maxCalls: 32 }`，gateway `commitTokens` 不再 no-op。Copilot proposal/chat 响应新增可选 `tokenUsage`（schema 兼容旧客户端）。Notebook 本就合并 usage 写入消息，现经同一 host 入口。

### P2-05 — Notebook/Copilot 入口取消 ✅（本批）

**修复：** SSE `POST /notebooks/:id/messages|cards` 在 request close/error 时 abort，signal 传入 `streamMessage`/`streamCard` → `streamHostEvents` → provider。Copilot JSON 路由同样绑定 abort，断开时吞掉 in-flight 错误（不把客户端断开报成 502）。已中止的 signal 在派发前直接拒绝。

### 批次四验证记录

环境：Node v22.23.2；日志 `.omo/evidence/delivery-batch4/`。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npx vitest run` hostInvoke + notebook + http + review-workload | ✅ exit 0，112/112 | `b4-suites.log` |
| `npm run typecheck` | ✅ exit 0 | `b4-typecheck.log` |
| `npx vitest run packages/schema apps/api packages/workload-review` | ✅ exit 0，929/929 | `b4-api-schema-wl-suite.log` |

## 第五阶段（2026-09-21 批次五）：快照收口、覆盖度、取消按钮、基线

### P1-09 — 默认 `pr-review` 混合失败必须出现在 review coverage ✅（本批）

**不是**把 workflow-runtime MiniReport 与 review coverage 做成同构。默认审查 workflow 步骤部分失败时：`runWorkflowStage` 仅在协议 `ok:false` 时失败 job；混合步骤把成功证据投影进 analyze 结果，`coverage.deterministicFailed` 为 true，Synthesizer 降级摘要，ReportPage 横幅写明确定性步骤未全部成功。

### P1-06③ 边界 — getBaseFile / 未变文件 / rename baseline ✅（本批，仍有预览上限）

- `contents_json` 信封 `{head,base}`，旧扁平 map 兼容解析。
- `getBaseFile` 先读 `reviewSnapshot.baseFileContents`（测试用与 git show 不同的 pinned-base 证明快照优先）。
- 工作树未变文件：索引时刻 `manifest.preview` 为钉住内容（含空文件），不再回落漂移后的磁盘。
- rename：`git show baseSha:previousPath`，内容同时记在新旧路径下。
- **仍保留**：preview 2048 字节上限；无 preview 的旧索引最后才活读；SHA clone 读克隆盘。

### P1-07① UX — Web 取消按钮 ✅（本批）

queued/running 的 ReportPage 显示危险按钮，调用 `POST /jobs/:id/cancel`。

### 生产运行模式残留

- `markdownRenderer` demo 分支已删；`LLMProvider` 注释已改。
- `mockProvider.ts` 保留为 CI double（产品路径：env 强设 `mock` 时 Pi 派发 fail-closed）。
- `LLM_NOT_CONFIGURED` 已统一为 503（批次六）。

### 批次五验证记录

环境：Node v22.23.2 + Python 3.12.10。日志 `.omo/evidence/delivery-batch5/`。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run verify:runtime` | ✅ Node v22.23.2 / Python 3.12.10 |
| `npm run verify:docs` | ✅ 49 Markdown |
| `npm test` | ✅ 1722 测例，`npm-test.log` |
| `pytest -q` | ✅ 296 passed |
| `npm run build` | ✅ api bundle + web dist |
| `npm run test:desktop` | ✅ 16 passed（冒烟对齐现行 API 指示器） |
| `npm run desktop:pack` | ❌ `Desktop package provenance requires a clean Git working tree. Commit changes before packaging.` 最小解除=owner 提交；未 reset、未 weaken |
| 产品 DeepSeek ping + `ReviewWorkload.run()` | ✅ SUCCEEDED / complete / 8 findings / 23s（不打印密钥/正文） |

## 第六阶段（2026-09-21 批次六）：证据锚点、完整钉住、用户流程

- P1-06②：confirmed 无相交证据记录则降 likely。
- 工作树未变文件钉住完整内容（64KB，与 Notebook 读上限相同），>2048B 回归覆盖。
- ContextVM：页持 RAW 分析字节，模型请求零泄漏（契约测试）。
- 侧栏连接走 App mutation，仓库列表不再空。
- 文档：dismiss / 取消；configuration 503。
- 桌面真实用户流程两阶段通过。`localRegistration` 全量超时余量 20s（隔离 ~1.2s，断言未改）。

## 剩余断点（owner）

- **P2-03 依据不足**，待澄清。
- 桌面重打包：先提交工作树，再 `npm run desktop:pack`；现安装包仍停在 `414ed5b` 且缺 web dist。
- ContextVM 原文页仍是分析镜像、不是模型出口（契约测试已钉住；不改为唯一出口）。
