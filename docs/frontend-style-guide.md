# ConsistenCy 前端风格指南（Codex × ZCode 融合）

> 视觉评审标准见 docs/design-qa/style-checklist.md；本文件记录实现约定，供后续开发遵循。

## 1. 主题机制

- 双主题由 apps/web/src/styles/tokens.css 定义：:root（浅色，历史配色）+
  :root[data-theme="dark"]（Codex 式深色调）。**暗色为默认**。
- apps/web/src/theme.tsx 的 ThemeProvider 负责 data-theme / color-scheme / localStorage
  （key: consistency.theme.v1，取值 dark | light | system）；index.html 内联脚本防首帧闪烁。
- 组件**禁止硬编码颜色**，一律引用 token。新增 token 必须同时写两个主题块。
- 契约测试：apps/web/src/styles/tokens.test.ts 会失败于任何未映射的硬编码色
  （图表专属色在测试的 ALLOWED 列表中显式登记）。

## 2. Token 家族速查

| 家族 | 用途 |
| --- | --- |
| background / surface / surface-subtle / surface-muted | 背景三层 + 内嵌区 |
| foreground / muted / muted-strong | 正文 / 次级 / 强调文本 |
| border / border-strong / border-subtle | 1px 细边框三档 |
| sidebar / sidebar-muted / sidebar-hover / sidebar-text* | 侧栏专用（恒为深色底） |
| primary / success / warning / danger + strong / soft / faint | 语义色三档 |
| focus-ring / shadow-soft / shadow-card / scrim / header-bg / overlay | 焦点 / 阴影 / 遮罩 / 顶栏 |

## 3. 排版与密度约定

- SHA、行号、状态、命令、路径、时长、计数 → var(--font-mono)（Cascadia Code 优先）。
- KPI 与表格数字：mono + font-variant-numeric: tabular-nums（body 已全局启用）。
- 列表行高 ≤ 40-46px（表格行 42px / 发现行 46px）；卡片留白 ≤ 内容高度的 1/3。
- 视觉标题 ≤ 3 级：顶栏 h1（22px）→ 面板 h2 → 行级标签。
- 圆角：面板/卡片 8px、控件 6px、徽标 999px。

## 4. 布局约定

- 顶栏 = mono 面包屑（ConsistenCy / 页面）+ 状态行 chips（心跳、provider/model、
  语言、主题、刷新；≤1100px 时隐藏 chips）+ 标题。
- 侧栏激活态 = 左侧 3px accent 边条（垂直居中）+ 微弱高亮，不用整块填充。
- 报告页 report 模式 = .report-ide 三栏（300px 发现列表 | 证据中心 | 340px Agent
  时间线，两侧 sticky 独立滚动；≤1200px 折叠单列）；Notebook 为全宽研究空间。
- 命令式输入 = > 前缀（mono、accent 色）+ mono 输入框。

## 5. 动效与可访问性

- 动效时长由 tokens.css 的 --duration-fast/normal/slow 令牌控制（140/220/360ms）；
  组件应引用令牌而非硬编码时长；prefers-reduced-motion 下全部归零（motion.css）。
- 全局 :focus-visible 焦点环（base.css）使用 --focus-ring；复选框 accent-color。
- 语义色对比度按 WCAG AA 校准（暗色采用 GitHub-dark 系明色）。
- 中英双语文案一律走 i18n.tsx 的 t()，不得硬编码界面文本。

## 6. 视觉 QA 回路

- 截图：npm run capture:screenshots（本机 Node 25 时用
  playwright.capture.node22.config.ts 临时配置，见 docs/design-qa/README.md）。
- 评审：workflow agent（provider google-vertex / gemini-2.5-flash）读
  style-checklist + 截图，输出结构化 issues；结果存 docs/design-qa/。
- 判定：critical / high 阻断；medium 尽量当轮修复；静态截图看不到焦点环属正常
  （焦点环只在键盘聚焦时出现），不得据此报 high。
