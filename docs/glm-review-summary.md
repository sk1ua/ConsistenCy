# ConsistenCy v2 前端改版与桌面化 — 工作总结（供 GLM 审阅）

> 审阅范围：本会话在 v2 分支上的全部改动。所有提交均在本地分支，**未推送**。
> 审阅重点建议：第 5 节"供审阅的重点问题"。

## 1. 背景与目标

- 仓库：ConsistenCy（确定性优先的代码审查基础设施，TS 编排 + Python 确定性引擎）。
- v2 分支相对 main 有 194 文件 / +20k 行改动（本地优先模块化重构），用户要求先评估后优化。
- 后续目标：前端按"Codex 终端质感 × ZCode IDE 布局"融合风格改版（暗色默认 + 浅色可选），
  并把 Web UI 封装为 Windows Electron 桌面应用（v1 依赖系统 Python 3.12）。

## 2. 提交清单（v2，共 12 个，未推送）

| 提交 | 内容 |
| --- | --- |
| 055987f | fix(engine): SQL 关键词只匹配 f-string 字面量（消除 14 个误报） |
| 4187402 | fix(engine): synthesizer 拒绝 continueOnError；TS/Python 字段级契约测试 |
| 09e7827 | feat(consistency-review): analyze_repo --baseline-ref + confidence 不再恒为 0 |
| 57a9112 | chore: housekeeping（.editorconfig/.gitattributes） |
| 9ed6749 | test(e2e): diff 工作区测试封闭化（自建 git 夹具仓库） |
| 7717d97 | chore(design-qa): 风格清单 + 改版前基线评审 + 截图存档 |
| 724d866 | feat(web): 双主题设计令牌（暗色默认）+ ThemeProvider + 225 处硬编码色清零 |
| a1797d2 | feat(web): IDE 外壳（侧栏激活边条/面包屑/状态行 chips/命令式输入） |
| 0a92c19 | feat(web): Report 页 IDE 三栏布局 + 密度与 mono 化 |
| 17d97aa | feat(web): 阶段 4 视觉验收 + docs/frontend-style-guide.md |
| 25b3af3 | feat(desktop): Electron 壳 + Python doctor + API 子进程 + smoke 测试 |
| 5a23f16 | fix(desktop): 生产级打包流水线（运行时安装/NODE_PATH/路径修复） |
| 9d7b0ad | chore: gitignore 桌面构建产物 |

## 3. 第一轮：确定性分析与测试基础设施修复

1. **安全启发式误报**：engine/agents/security_agent.py 对 f-string 做整段关键词匹配，
   `{where}`、`{select!r}` 等插值表达式名大写后命中 WHERE/SELECT。改为只匹配字面量
   文本 + 词边界 + 要求存在插值；spec.py 的 12 个误报归零，真实线索（indexer.py 参数化
   占位 SQL）保留。新增 3 个回归测试。
2. **confidence 恒为 0**：engine/runner.py 调用 build_confidence() 不传参（注释写明
   "Can be enhanced"）。现按"是否有基线快照 + 信号一致性"计算：有基线 → [0.45, 0.80]，
   无基线 → <0.45（仅人工复核线索）。
3. **analyze_repo.py 新增 --baseline-ref**：通过只读 git show 取每文件基线快照，新文件
   保持低置信度。附带 CLI 回归测试。
4. **跨语言契约**：tests/test_workflow_spec.py 新增字段级断言（字段集/超时默认值与边界/
   step id 正则 vs packages/schema/src/workflow.ts），并发现真实 drift：Python 侧 synthesizer
   接受 continueOnError 而 TS strict schema 拒绝 → 已收紧 Python。
5. **e2e 两个真实缺陷**：
   a) diff 工作区测试用 process.cwd() 当目标仓库，依赖工作区恰好是脏的 → 改为自建 git
      夹具仓库；playwright.config 固定 e2e 根目录（Playwright 多进程加载配置，每进程
      mkdtemp 导致 API 与测试看到不同根目录）。
   b) capture spec 引用已删除的 real-data 视图与陈旧 i18n 键 → 修正。
6. **本机环境**：默认 Node 25 与项目基线 Node 22 不匹配（better-sqlite3 ABI 127 vs 141），
   33 个 api 测试在 Node 25 下失败；用 `npx -y node@22` 验证 295 个 api 测试全绿。

## 4. 第二轮：前端视觉改版（Codex × ZCode 融合风）

### 设计 QA 回路（阶段 0）
- harness 默认 subagent（deepseek-v4-flash）无视觉；workflow 工具 provider 覆盖
  `google-vertex` + `gemini-2.5-flash` 可读图 → 确立"截图 → Vertex 评审 → 修复迭代"闭环。
- 产物：docs/design-qa/style-checklist.md（评审标准）、baseline-review.json、
  stage1-4 评审存档、docs/frontend-style-guide.md（实现约定）。

### 阶段 1：双主题设计令牌
- tokens.css 重构：:root（浅色，历史配色）+ :root[data-theme="dark"]（Codex 式深色调，
  #0d1117 系）。ThemeProvider（dark 默认 / light / system，localStorage + 首帧防闪）。
- 脚本化转换 225 处硬编码色 → token（含 15 处 --sidebar-hover 误用作正文色、顶栏背景
  误归 --sidebar-text-bright 等映射错误）；tokens.test.ts 以源码即数据锁定"零硬编码色"。

### 阶段 2：外壳
- 侧栏激活态 3px accent 左边条（top:50% + translateY 居中）；顶栏 mono 面包屑 +
  状态行（心跳 chip + LLM provider/model chip，≤1100px 隐藏）；PR 输入命令式化（> 前缀）。

### 阶段 3：Report IDE 三栏
- report 模式改为 300px 发现列表 | 证据中心 | 340px Agent 时间线（sticky 独立滚动，
  ≤1200px 折叠）；Notebook 全宽化（与 README"全页研究空间"文档一致）。
- 密度与终端化：表格行 42px、发现行 46px、KPI/时长/风险数字 mono + tabular-nums。

### 阶段 4：验收
- 11 视图 × 暗/亮截图 → Vertex 评审 → 修复（激活条居中、标题两行截断、chip 醒目度、
  时间对齐、复选框 accent-color）→ 复检无 high/critical（像素级异议记录在案）。

### 验证矩阵（全部通过）
- pytest 259 / Web vitest 23 / api vitest（Node 22）295 / e2e 6 条（Node 22 临时配置）/
  typecheck 全工作区 / 打包产物端到端。

## 5. Electron 桌面化（阶段 5）

### 架构
- apps/desktop（electron 33.4.11）：main 进程做 Python 3.12 doctor（退出码判定，零管道，
  沙箱兼容）→ spawn API 子进程（ELECTRON_RUN_AS_NODE + tsx）→ health 就绪后开窗口
  （file:// 加载 web dist，contextIsolation + sandbox + 最小 preload）。
- userData 隔离：DATABASE_PATH / workspaces / settings 均在 %APPDATA%\@consistency\desktop。
- 打包：desktop-pack.mjs 生成运行时 manifest → npm install --omit=dev 到 staged/runtime →
  electron-rebuild（Electron ABI）→ 目录改名 modules/ → electron-builder --win dir。

### 打包流水线踩坑（全部已修复，均有验证）
1. **junction 递归爆炸**：直接拷贝 repo node_modules 时，workspace 链接经
   @consistency/desktop → apps/desktop → staged 自引用，6.4GB 仍增长 → 改为 manifest 安装。
2. **electron-builder 剔除所有名为 node_modules 的目录**（任意层级）→ 运行时树改名
   modules/ + 打包态 NODE_PATH 指向它（Node CJS require 查询 NODE_PATH）。
3. **file: workspace 依赖装成 junction**，进包时 electron-builder 无法重建 → 安装后
   物化为真实目录（先 rename 链接再拷贝，避免误删目标）。
4. **winCodeSign 缓存解压失败**：7za 创建 darwin .dylib 符号链接需要特权（本机无
   Developer Mode）→ 用 7za -snl- 预解压到最终缓存目录名 winCodeSign-2.6.0（builder
   命中缓存跳过）；README 记录了 NSIS/portable 安装器的启用步骤。
5. **主进程调试**：GUI 无 stdout → 文件日志；spawn error 事件未监听 → 静默失败；
   stagedRoot() 层级计算错误（src → desktop → apps → root 需 ..×3）；vite 绝对资源
   路径导致 file:// 白屏 → --base=./。

### 桌面验证
- Playwright _electron smoke：窗口 + 侧栏 + API health（1.8s）✓
- 打包产物 win-unpacked 独立启动：doctor 通过 → API 3001 health 200 → 窗口出现 ✓
- 产物：apps/desktop/release/win-unpacked/ConsistenCy.exe（270MB，未签名）。

## 6. 已知限制与后续建议

1. **NSIS/便携安装器**未产出：本机需开 Developer Mode 或按 README 缓存技巧执行
   DESKTOP_TARGETS 打包；产物未签名（SmartScreen 会提示）。
2. **asar 关闭**（engine 需被 Python 读）；体积优化（内嵌专用 Node/Python）是二期。
3. **better-sqlite3 ABI 双态**：桌面运行需 Electron ABI，Node 22 测试需恢复（README 有
   双向命令）；会话结束时已恢复 Node 22 ABI。
4. **视觉评审回路的主观性**：Vertex 评审对静态截图的像素级主张有时不一致（焦点环
   不可见被误报 high 等），判定规则已写入 style-checklist 与 design-qa/README。
5. 两个临时 Playwright 配置（node22 变体）未提交，用户切 Node 22 后可删。
6. 全部提交未推送；README 提及的 doctor 徽标（Node/Python 基线）在 Web 顶栏未实现
   （API 无 doctor 端点，属范围裁剪，桌面端有等价检查）。

## 7. 供审阅的重点问题

- A. 安全启发式改为"字面量 + 词边界 + 必须含插值"：索引器占位符 SQL（f"...IN
  ({placeholders})"）仍会命中——语义上是否应豁免"占位符列表"模式？
- B. confidence 公式（0.45×基线项 + 0.35×一致性 + 0.20×历史）在单基线快照下基线项
  饱和为 1——数值标度是否合理？影响 API 输出与技能语义（≥0.45 = 有基线）。
- C. e2e 根目录固定为 %TEMP%\consistency-e2e（非 mkdtemp）：并行 e2e 会互踩，
  当前 CI 单机单跑可接受——是否应改为 env 注入每任务唯一根？
- D. 桌面端 NODE_PATH 方案（modules/ 改名 + 环境变量）依赖 CJS require 语义；tsx 内部
  为 CJS 兼容而工作，但属脆弱解法——是否应改为 extraResources 保留 node_modules 原布局？
- E. winCodeSign 缓存预解压技巧只在本机验证；建议在 CI 环境验证安装器构建路径。
- F. 打包产物未签名 + asar:false：发布前安全评估（供应链、篡改检测）。
- G. 视觉改版中若干"评审者像素级异议"被判定为低于可执行精度而放行（记录于
  stage4-acceptance-review.json）——若要求严格一致性可复查。

## 8. GLM 审阅后修复记录

基于审阅报告发现的 4 类问题已修复并通过验证（web vitest 24/24, typecheck, pytest 259/259）。

### 8.1 暗色主题对比度回归（4 处，已修复）

令牌清扫时硬编码色按色值映射而不检查令牌在两主题下的语义角色，导致暗色下 4 处文字不可读。

| 位置 | 原值（暗色 1.35:1） | 修复后 | 暗色对比度 |
|---|---|---|---|
| report.css `.finding-detail pre` | bg:sidebar + fg:border-subtle | bg:surface-muted + fg:foreground + 边框 | 12.6:1 |
| workspace-enhancements.css `.markdown-content code` | bg:surface-muted + fg:#173f5f | bg:primary-soft + fg:primary-strong | 6.8:1 |
| tables.css `.badge-public-read` | fg:#17628f | fg:primary-strong | 5.9:1 |
| controls.css `.notice small` | fg:#85683f | fg:muted-strong | 5.6:1 |

`tokens.test.ts` 的 ALLOWED_HEX 已清空（豁免注释声称"chart-only"但实际为文字色，理由不成立）。

### 8.2 report-ide 折叠断点（已修复）

风格指南和总结文档写"≤1200px 折叠"，但代码在 680px 才折叠——680–1220px 区间中心栏被 300+340px 侧栏挤压至不足 155px，内部 minmax(240px) 必然溢出。在 responsive.css 1220px 断点块补充了 `.report-ide { grid-template-columns: 1fr }` 及侧栏 static 规则，使文档与代码一致。

### 8.3 测试加固

- `tokens.test.ts`：cssFiles() 改为递归扫描（未来新增嵌套目录 CSS 不会漏检）。
- `theme.test.tsx`：新增 anti-flash 脚本 localStorage key 同步断言（key 改名不再静默闪屏）。
