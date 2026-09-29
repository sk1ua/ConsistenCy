# ConsistenCy v3 交付就绪矩阵（delivery-readiness）

目的：为「可交付版本」给出单一事实源——完整交付范围、逐项现状与证据、优先级批次、每批命令/退出码/日志路径、当前阻塞。监督方式：Codex 只读复核，代码实现全部由执行侧完成。

- 基准：HEAD `e58ecb2` + 工作树未提交改动（审计修复第一阶段 5 项 + 2026-09-19 批次一 3 项）。修复明细与逐批验证记录见 `remediation-progress.md`；本文件只做交付视角的矩阵与排期。
- 证据纪律：每条结论必须带 file:line 或日志路径；**未执行的检查不得写成通过**；禁止输出密钥；禁止 push / 发布 / 发表评论（owner 专属动作）。
- 复核方法：四路并行只读代码核实沿真实生产调用链（入口 → context builder → ReviewWorkload → prompts → provider；jobDiff resolver；store/迁移；桌面打包链）+ 执行侧对关键路径的亲自复核。

## 证据边界（原始报告不可寻回）

原《ConsistenCy-v3-architecture-audit》文件（owner Temp 目录）已不存在。本文与 `remediation-progress.md` 中的条目依据分三档，复核与后续修复一律以当前代码为准：

| 档 | 条目 | 说明 |
|---|---|---|
| 冻结转写 | P0-01、P1-05、P1-11、P1-08、P2-02 | 第一阶段逐项描述为报告结论的冻结转写，含生产链证据 |
| 短标题重建 | P1-01、P1-02、P1-03、P1-04、P1-06、P1-07、P1-09、P1-10、P2-04、P2-05、P2-06、P2-07 | 冻结摘要仅存短标题；实质按当前代码逐项重核，不冒称原文 |
| 依据不足 | P2-03 | 冻结摘要无对应描述，无法确定其指代；待 owner 提供原文或确认废弃 |

## 一、交付范围

1. 快照与证据持久性（P1-01/04/06）
2. 取消与恢复（P1-02/07）
3. 模型入口控制（P1-03、P2-04/05）
4. workflow/UI 真实性（P1-09/10、P2-06/07、P2-03）
5. 真实 LLM 核心流程（无 mock 残留、诚实失败路径、环境契约）
6. 桌面打包安装（产物与 HEAD 一致、安装态冒烟）
7. 文档（与现实一致、新能力覆盖）

## 二、审计项现状矩阵

状态：✅ 已修（本批）｜✅（一批，工作树未提交）｜◐ 部分｜✗ 未修｜＝ 已达标（无需修复）。

| 项 | 状态 | 关键证据（file:line 以 e58ecb2+工作树为准） |
|---|---|---|
| P0-01 模型可见内容策略 | ✅（一批 + 本批增补 diff 段排除） | `packages/workload-review/src/context/content-policy.ts`（applyModelContentPolicy + dropSecretPathDiffSections）；红→绿证据 `.omo/evidence/delivery-batch1/p0-01b-*.log` |
| P1-01 工作树快照身份 | ✅（本批） | 迁移 `0023_job_review_snapshots`；`jobQueue.ts`/`sqliteJobStore.ts` save/getReviewSnapshot；`buildLocalContext` 双返回；`contextRouter.ts` onWorkingTreeSurface；`jobDiff.ts` 快照优先+`pinned`；`jobSnapshotPersistence.test.ts` 全场景 |
| P1-02 capability 终态撤权 | ✅（批三） | `review-workload.ts` #issuedHandles+#issuedCount、#revokeIssuedCapabilities 在成功/失败/取消三路径全量 revoke；result.capabilitiesIssued/Revoked 可断言；测试覆盖三路径 |
| P1-03 WorkingSet 唯一模型出口 | ✅（批四，VM 非出口） | review 三条路径过 content-policy；Notebook/Copilot 经 `hostInvoke.ts` `redactModelVisibleText`；ContextVM 页仍持原文但无 prompt 出口 |
| P1-04 evidence 耐久 resolver | ✅（批二） | `report.ts` reviewEvidenceRecordSchema + report.evidence；`review-workload.ts` 持久化边界前全量附加（toDurableEvidenceRecord）；测试断言 serialize→parse 往返后 findings.evidenceIds 全可解 |
| P1-05 覆盖度诚实 | ✅（一批） | `report.ts` reviewCoverageSchema；ReportPage degraded 横幅（本拉取已与上游 all-dismissed 状态合并） |
| P1-06① 默认 workflow 丢 evidencePack | ✅（批二） | `workflowAdapter.ts` evidencePackFromRun（RetrievalTrace 同形投影，candidate/溯源/summary）；默认路径报告带 retrieval、Notebook getEvidencePack 不再占位；无证据 run 仍返回 undefined |
| P1-06② confirmed 证据规则 | ✅（批六） | `groundReviewFindings`：confirmed 通过 hunk+signal 后若无相交 Evidence 记录则降为 likely；空 store 永不产出 confirmed。测试：`review-grounding.test.ts` |
| P1-06③ Notebook/Diff 快照漂移 | ✅（批五收口） | 批二：contents_json + 变更文件审查时内容。批五：`contents_json` `{head,base}` 信封（旧扁平 map 仍可解析）；`getBaseFile` 先读 `baseFileContents`；工作树未变文件走索引时刻 `manifest.preview`（含空文件），不再回落活盘；`searchRepository` 回退同样走 `readSelectionText`；rename baseline 用 `previousPath`。**仍保留的边界**：preview 上限 2048 字节（超出部分不活读、也不补全）；SHA 钉住的 clone 仍读克隆盘（对象本身已钉住）；无 preview 的旧索引最后才活读 |
| P1-07① 取消贯通外部调用 | ✅（批三 + 批五 UX） | 批三：四层贯通到 `POST /jobs/:id/cancel`。批五：`ReportPage` queued/running 显示危险按钮，`api.cancelJob` 成功后本地覆盖 job 状态 |
| P1-07② 重启恢复 | ✅（本批） | `failInterruptedRunningJobs`（jobQueue.ts/sqliteJobStore.ts）+ server.ts 启动无条件收敛；测试 `.omo/evidence/delivery-batch1/p1-07b-recovery-green.log` |
| P1-07③ shutdown 截止 | ✅（批三） | `worker.stop({ms,onExpiry})` 双窗口+放弃返回+循环代际守卫；server 关停接线 requestCancelAll；`CONSISTENCY_SHUTDOWN_GRACE_MS`（默认 30s）；测试证明 <300ms 返回且 onExpiry 恰一次 |
| P1-08 隔离声明真实性 | ✅（一批） | observability.ts deriveSecurityGuarantees；DEFAULT 全 not-enforced |
| P1-09 workflow 覆盖结果 | ✅（批五，默认审查路径） | 默认 `pr-review` 混合步骤失败不再把整 job 打成 analyze 失败：`runWorkflowStage` 协议 ok 即投影成功步骤证据；`coverage.deterministicFailed` + Synthesizer/ReportPage 横幅。未做 schema 同构：workflow-runtime MiniReport 仍是另一产品，自身诚实、不共享 review coverage |
| P1-10 audit 产物链 | ＝ | `audit/executor.ts` fenced 认领/不可变链接/终态镜像/净化错误；`server.ts:322-337,667-679` 装配与启动对账；路由 steps/report/events/cancel/export（`http.ts:2425-2504`） |
| P1-11 demo 合成 diff | ✅（一批） | jobDiff.ts 合成分支已删，unavailable 诚实语义 + 测试 |
| P2-02 Synthesizer 重复 | ✅（一批） | 快照 agentRuns 后建报告 |
| P2-03 （依据不足） | ？ | 冻结摘要无描述；待 owner 确认指代或废弃 |
| P2-04 模型入口统一记账 | ✅（批四） | review llm capability 带 maxTokens/maxCalls；Copilot 响应可选 tokenUsage；Notebook 消息继续记 usage，现经 host 入口 |
| P2-05 模型入口取消 | ✅（批四） | Notebook SSE close→AbortSignal→streamHostEvents；Copilot JSON close 中止 in-flight；review 路径批次三已通 |
| P2-06 RuntimePanel 首次 unavailable | ＝ | 首载/无数据/错误均诚实空态（`RuntimePanel.tsx:338-385`）；兜底快照保证声明已由一批改为诚实地板值 |
| P2-07 模式能力矩阵 | ✅（批五文档） | `docs/capability-matrix.md`；README 已索引；security.md 隔离表改为 in-process 诚实口径 |
| P1-06②'（新）jobDiff pinned 披露 | ✅（本批） | `pinned` 字段贯穿 schema→http→useJobDiff→ReportRoute 漂移横幅 |

## 三、交付维度现状

### 真实 LLM 核心流程 —— 产品配置可用，桌面用户流程已跑通
- 正规渠道：`.consistency/config.json` + `secrets.enc.json`（无仓库根 `.env`）。`npm run config -- doctor`：`deepseek credentials are configured`；GitHub App 未配置（webhook PR 路径不可用，不阻塞本地审查）。
- 产品 factory ping：`generateSummary` ok（provider=deepseek，有 tokenUsage，520ms）。
- 桌面真实用户流程（Electron，真实文件夹选择器仅 stub OS 对话框、main 真正注册；真实 DeepSeek）：连接仓库 → 取消审查#1（job 终态 `cancelled`）→ 审查#2 SUCCEEDED → 报告/差异/证据 → Notebook 追问带文件:行号引用 → 重启同一 user-data 后报告与 Notebook 历史仍在。证据 `.omo/evidence/delivery-batch6/`（截图 + job-id）。
- `MockLLMProvider` 判断口径是**产品路径是否可达**，不是目录名：设置 UI / Pi catalog 不可选 `mock`；env 强设 `LLM_PROVIDER=mock` 时 factory 会构造同名适配器，但 Pi 派发 fail-closed（`Pi has no authenticated model for provider 'mock'`）。AGENTS.md 允许的 CI double 保留。
- `LLM_NOT_CONFIGURED` 已统一为 HTTP 503（审查入口与 Copilot）。markdownRenderer demo 分支已删。

### 桌面打包安装 —— 本批未出包（clean-tree 门闸）
- `npm run desktop:pack` 实测错误：`Desktop package provenance requires a clean Git working tree. Commit changes before packaging.`（`scripts/desktop-pack.mjs:63`）。最小解除条件：owner 提交当前工作树后再跑；禁止 reset/weaken。存在 `CONSISTENCY_ALLOW_DIRTY_PACK=true` 逃生口，本批未使用。
- 现安装包仍停在 `414ed5b`，缺 web dist 的问题未变，须重打包后才可分发。
- `npm run test:desktop` 16/16；`npm run test:e2e` 23/23。

### 文档
- P2-07 矩阵：`docs/capability-matrix.md`。
- `docs/configuration.md`：通用 `LLM_*` / Pi catalog；未配置时审查与 Copilot 均为 503。
- `docs/api.md`：含 `POST /jobs/:id/cancel`、`GET /repositories/:id/git/tree|file`。
- `docs/review-runtime.md`：finding dismiss（纯 localStorage 分诊）与取消语义。
- `verify:docs` 49 Markdown 通过。

## 四、优先级与批次

| 批次 | 内容 | 状态 |
|---|---|---|
| 一（2026-09-19） | P0-01 增补（diff 段排除）、P1-01 快照持久化、P1-07② 重启恢复；2026-09-20 自审修补 S1（previousPath 语义）/S2（CRLF 泄漏向）/S9（注释） | ✅ 完成 + 已自审修补，证据见下 |
| 二（2026-09-20） | P1-06① 默认 workflow evidencePack + P1-04 evidence 随报告持久化（耐久 resolver）+ P1-06③ notebook 接审查快照（含迁移 0024） | ✅ 完成，证据见下 |
| 三（2026-09-20） | P1-07① 取消 API + AbortSignal 贯通 + P1-07③ shutdown 双窗口 + P1-02 三终态撤权 | ✅ 完成，证据见下 |
| 四（2026-09-21） | P1-03 Notebook/Copilot 模型入口收敛 + P2-04 记账 + P2-05 Notebook/Copilot 取消 | ✅ 完成，证据见下 |
| 五（2026-09-21） | P1-09 默认 workflow 混合失败 → review coverage；P1-06③ getBaseFile/未变文件 preview 钉住；Web 取消按钮；生产 mock 注释；AGENTS.md 可执行基线 + 真实 DeepSeek 审查探测 | ✅ 完成，证据见五 E |
| 六（2026-09-21） | P1-06② confirmed 强制证据锚点；未变文件 >2048B 完整钉住；ContextVM 契约测试；LLM_NOT_CONFIGURED=503；dismiss/cancel 文档；侧栏连接刷新仓库缓存；桌面真实用户流程两阶段；`test:e2e` 23/23 | ✅ 完成，证据见五 F |
| 收尾（owner） | 提交工作树后 `desktop:pack` + 安装态冒烟；GitHub App/登录 30s 验证；P2-03 澄清。**未做不得写通过** | 阻塞：dirty tree 禁止打包；P2-03 待澄清 |

## 五、批次一证据记录（2026-09-19）

环境：Node v22.23.2（pinned portable，`$HOME/.zcode/tmp/node22b/node-v22.23.2-win-x64`）。日志目录：`.omo/evidence/delivery-batch1/`。

| # | 命令 | 退出码 | 日志 |
|---|---|---|---|
| 1 | `npx vitest run` content-policy + review-workload（修复前复现） | 1 | `p0-01b-reproduce-red.log`（模型 userPrompt 出现 `+ADDED_SETTING=gamma`，证明旁路） |
| 2 | `npx vitest run` 同上（修复后） | 0 | `p0-01b-fixed-green.log`（35/35） |
| 3 | `npx vitest run` sqliteJobStore + jobQueue | 0 | `p1-07b-recovery-green.log`（14/14） |
| 4 | `npx vitest run` jobSnapshotPersistence + jobDiff + jobDiff.route + buildLocalContext | 0 | `p1-01-snapshot-green.log`（18/18） |
| 5 | `npm run typecheck`（全 workspace） | 0 | `batch1-typecheck.log` |
| 6 | `npx vitest run packages/schema apps/api`（全量） | 0 | `batch1-api-schema-suite.log`（858/858） |
| 7 | `npx vitest run` useJobDiff + ReportRoute + ReportPage + workload-review | 0 | `batch1-web-wl-suite.log`（59/59） |
| 8 | `npm run verify:docs` | 0 | `batch1-verify-docs.log`（48 个 Markdown） |

批次一覆盖的监督指定回归场景：staged/unstaged/untracked/删除/重命名混合审查 → 改写工作树 + 同库新开 store（模拟重启）→ 旧报告 diff/证据引用仍对应审查时内容、新审查用新内容、`.consistencyignore` 与秘密文件边界全程成立（`jobSnapshotPersistence.test.ts`）。未以「简单返回 unavailable」替代持久化：仅对快照之前的旧数据显式标 `pinned:false` 并在 UI 披露漂移。

## 五B、批次二证据记录（2026-09-20，审查者=实现方自审）

日志目录：`.omo/evidence/delivery-batch2/`。批次一自审修补日志：`delivery-batch1/batch1-selfreview-fixes.log`（19/19）。

| # | 命令 | 退出码 | 日志 |
|---|---|---|---|
| 1 | `npx vitest run` notebook + workflowAdapter + jobSnapshotPersistence + review-workload（定向） | 0 | `b2-suites.log`（42/42） |
| 2 | `npm run typecheck`（全 workspace） | 0 | `b2-typecheck.log` |
| 3 | `npx vitest run packages/schema apps/api packages/workload-review`（全量） | 0 | `b2-api-schema-wl-suite.log`（907/907） |
| 4 | `npx vitest run` ReportPage + ReportRoute | 0 | `b2-web-suite.log`（14/14） |

批次二核心回归场景：默认 workflow 路径产出真实 retrieval（结构对齐引擎 RetrievalTrace）；报告 serialize→schema-parse 往返后所有 finding.evidenceIds 可解（重启等价）；工作树审查漂移后 Notebook 文件读取与 getDiff 返回审查时内容、post-review 内容不出现；range diff 三点语义与审查一致（base 侧变更不出现）；快照 fileContents 无秘密路径/删除文件内容入库。

## 五C、批次三证据记录（2026-09-20，审查者=实现方自审）

日志目录：`.omo/evidence/delivery-batch3/`。

| # | 命令 | 退出码 | 日志 |
|---|---|---|---|
| 1 | `npm run typecheck`（全 workspace） | 0 | `b3-typecheck.log` |
| 2 | `npx vitest run packages/schema apps/api packages/workload-review packages/kernel packages/harness-core`（全量） | 0 | `b3-full-suite.log`（1111/1111） |
| 3 | 自审修复后复跑（workload-review + worker + jobCancel + taskManager） | 0 | `b3-selfreview-fixes.log`（72/72） |
| 4 | `npm run verify:docs` | 0 | 48 个 Markdown（终端确认） |

批次三核心回归场景：取消在飞模型调用（hang 驱动 + 真实 abort signal 断言、后续 agent 零调用、run CANCELLED 非 FAILED、取消即撤权）；run 前取消不产降级报告；成功/失败/取消三路径全量撤权（revoked===issued）；关停宽限 50ms 中断 300ms 挂起（onExpiry 恰一次、<300ms 返回、job 事后收敛）；取消 job 不被 worker 改写为 failed；取消路由 404/409/200 三态 + live-run 先信号后落库。

## 五D、批次四证据记录（2026-09-21，审查者=实现方自审）

日志目录：`.omo/evidence/delivery-batch4/`。

| # | 命令 | 退出码 | 日志 |
|---|---|---|---|
| 1 | `npx vitest run` hostInvoke + notebook + http + review-workload | 0 | `b4-suites.log`（112/112） |
| 2 | `npm run typecheck` | 0 | `b4-typecheck.log` |
| 3 | `npx vitest run packages/schema apps/api packages/workload-review` | 0 | `b4-api-schema-wl-suite.log`（929/929） |

批次四核心回归：合成 token 进 Notebook 证据后模型 prompt 不含该值；已中止 signal 使 Notebook run.failed 且零次 stream 派发；Copilot 成功响应带 tokenUsage 且 invocation 带 signal；review-security 的 llm.invoke 记录带 `{ maxTokens: 250000, maxCalls: 32 }`。

## 五E、批次五证据记录（2026-09-21，审查者=实现方自审）

环境：Node v22.23.2；Python 3.12.10（`CONSISTENCY_PYTHON_PATH=.venv`）。日志：`.omo/evidence/delivery-batch5/`。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 全 workspace `tsc --noEmit` |
| 2 | `npm run verify:runtime` | 0 | Node v22.23.2 + Python 3.12.10 |
| 3 | `npm run verify:docs` | 0 | 49 Markdown |
| 4 | `npm test` | 0 | 工作区合计 1722 测例（含 runtime-gate 4）；日志 `npm-test.log` |
| 5 | `./.venv/Scripts/python.exe -m pytest -q` | 0 | 296 passed in 2.66s |
| 6 | `npm run build` | 0 | `apps/api/dist/server.cjs` + `apps/web/dist/index.html` |
| 7 | `npm run test:desktop` | 0 | 16 passed（冒烟文案对齐后） |
| 8 | `npm run desktop:pack` | 1 | clean-tree 门闸，见上引原文 |
| 9 | `npm run config -- doctor` | 0 | deepseek 已配置；GitHub App 未配置 |
| 10 | 产品 factory `generateSummary` ping | 0 | provider=deepseek，有 usage，520ms |
| 11 | 产品 `ReviewWorkload.run()` 真实模型 | 0 | SUCCEEDED / complete / 8 findings / 23s |

未运行：安装包冒烟（无新包）。未 push / 未发布 / 未发评论。

## 五F、批次六证据记录（2026-09-21）

环境：Node v22.23.2；Python 3.12.10。日志/截图：`.omo/evidence/delivery-batch6/`。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 全 workspace |
| 2 | `npm test` | 0 | 1727 测例（api 794 含 localRegistration 20s 超时余量；web 413） |
| 3 | `pytest -q` | 0 | 296 passed |
| 4 | `npm run verify:docs` | 0 | 49 Markdown |
| 5 | `npm run test:e2e` | 0 | 23 passed |
| 6 | `npm run test:desktop` | 0 | 16 passed |
| 7 | 桌面真实用户流程 phase A | 0 | 连接→取消→真实审查→报告/差异/证据→Notebook；列表页可见 flow-demo |
| 8 | 桌面真实用户流程 phase B | 0 | 同 user-data 重启后报告 100 分 / 6 发现、Notebook 历史仍在 |
| 9 | `npm run desktop:pack` | 1 | clean-tree 门闸（未提交、未 weaken） |

`localRegistration.http.test.ts` 全量两次在默认 5s 墙超时（无断言失败）；隔离 1.1–1.3s。该用例含两套 git init + ~10 次串行 HTTP。超时改为 20s，断言未改；随后全量 794/794。

真实流程发现并已修：侧栏「连接仓库」直接调 `desktopBridge.selectRepository()`、不走 App mutation，详情页能进、仓库列表/侧栏缓存仍空。现经 `onSelectLocalRepository` → mutation（写缓存 + invalidate）再导航。phase A 在 `#/repositories` 断言 `flow-demo` 可见。

## 六、当前阻塞与待提交

- **owner 决策**：P2-03 依据不足（提供原始报告或澄清指代；暂标待澄清）。
- **owner 专属动作**：提交下列源文件（见下）；然后 `npm run desktop:pack`（Node 22.19–22.x）与安装态冒烟；GitHub 登录 30s 验证；push。
- **已知环境约束**：系统 Node 25.8.1 不满足 engines；`verify:runtime` 需 `CONSISTENCY_PYTHON_PATH` 指向 `.venv`。

### 待提交范围（排除凭据、数据库、生成产物）

**不要提交：** `.consistency/`（含 `secrets.enc.json` / `config.key`）、`.env`、`apps/api/dist`、`apps/web/dist`、`.omo/`、`test-results/`、`playwright-report/`、`node_modules/`、本地 SQLite。

**要提交：** 当前工作树全部 `M` / `??` 源文件与文档（审计批次一～六）。摘要：内容策略与快照身份、取消贯通、coverage 诚实、Notebook 钉住、hostInvoke、confirmed 证据锚点、LLM_NOT_CONFIGURED=503、侧栏连接缓存、能力矩阵与交付文档、桌面冒烟文案对齐。

建议提交信息（owner 自行 `git add` / `commit`）：

`fix(review): persist working-tree snapshots, honest coverage, and cancel through the model`

## 七、打包与安装态记录（2026-09-22 最终更新）

本地提交（未 push）：

| SHA | 说明 |
|---|---|
| `e23c6e0a633f0b6b984ce892b7796b447673999c` | 工作树快照、coverage、取消、Notebook 钉住 |
| `bc5a5a2bf7e618287ffe2a8ab865f0edb6c753af` | 默认 `pr-review` JSON，安装态不依赖 PyYAML |
| `1974dbf316ae8c7c4bd28f3e6681a354f954bc97` | 文档与 verify-docs 规则更新 |
| `0072e222cffb663d42be644ae4b4afdcabcd2841` | 第二轮缺陷实修：根治无法加载差异(757文件大改动截断展示)、真实评分与风险语义(消除0分/横杠/中与critical矛盾)、左右侧栏独立折叠与快捷键自适应、设置页API Key配置状态同步与GitHub OAuth会话持久退出 |

正规 `npm run desktop:pack`（`DESKTOP_TARGETS=nsis dir`，未设置 `CONSISTENCY_ALLOW_DIRTY_PACK`），`build-info.json` `commitSha=0072e222cffb663d42be644ae4b4afdcabcd2841`。

| 产物 | 绝对路径 | SHA-256 |
|---|---|---|
| NSIS 安装包 | `D:\sk1ua\python\ConsistenCy-pr2-clean\apps\desktop\release\ConsistenCy-Setup-0.1.1-x64.exe` | `8dbb7138c44730fc589f22d4ae47e95ef086aa324bc03cc9cffea8db10de2559` |
| win-unpacked | `D:\sk1ua\python\ConsistenCy-pr2-clean\apps\desktop\release\win-unpacked\ConsistenCy.exe` | （随包） |

第二轮安装态静默安装至 `D:\sk1ua\python\ConsistenCy-pr2-clean\.omo\evidence\delivery-pack2\installed\`。CDP 全流程验证通过（设置页 API Key 真实已配置同步、GitHub 登录态持久化与退出、左右侧栏独立收起展开及中间画布全屏扩展、job_71a5 757 文件大差异正常加载且无 413 错误、消除重复摘要）。截图保存在 `.omo/evidence/delivery-pack2/screenshots/p2-01–p2-06`。

## 八、剩余阻塞（仅此）

1. **P2-03** 待澄清（审计原文缺失，保持待澄清状态，不冒称原审计项全部完成）。
2. **GitHub App 未配置**：本地审查与公开 PR 分析可用；webhook PR 与 GitHub 评论发布不可用。配置步骤见 `docs/GITHUB_APP_SETUP.md`。
