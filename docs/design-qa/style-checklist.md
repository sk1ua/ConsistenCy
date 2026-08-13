# ConsistenCy 前端视觉风格清单（Codex × ZCode 融合）

用于视觉评审回路（截图 → 视觉模型评审）的评审标准。每条对应一个可核查项；
评审输出按 severity（critical / high / medium / low）+ location + description + suggestion 记录。

## 1. 色彩与主题

- [ ] 暗色为默认主题，浅色可切换；两种主题均不得出现未定义 token 的裸色值
- [ ] 背景分层清晰：app 底 → 面板面 → 内嵌区，至少 3 级可辨识（暗色参照 #0d1117 系）
- [ ] 语义色（success/warning/danger）与文字对比度满足 WCAG AA（正文 ≥ 4.5:1，大字 ≥ 3:1）
- [ ] 聚焦环在所有可交互元素上可见（2px、accent 色、offset 1px）
- [ ] 边框克制：细 1px、低饱和，避免高对比描边挤占信息

## 2. 排版与密度

- [ ] 正文 UI 用系统字体栈；SHA、行号、状态、命令、路径一律 monospace（Cascadia Code 优先）
- [ ] 数字指标（KPI、时长、计数）用 tabular-nums / mono 对齐
- [ ] 信息密度对齐 IDE：列表行高 ≤ 40px，卡片留白不得大于内容高度的 1/3
- [ ] 层级清晰：页面标题 > 区块标题 > 行标签，同一页面不超过 3 级视觉标题
- [ ] 中英双语下均无溢出/截断（长 SHA、长路径换行策略明确）

## 3. 布局与结构

- [ ] 顶栏 = 面包屑 + 状态行（心跳、provider/model、语言、主题、刷新、doctor 徽标）
- [ ] 侧栏 = 深色分层、激活态左侧边条、图标 16px 线性风；折叠态可用
- [ ] 工作区页面（Report）为 IDE 分栏：列表 / 主内容 / 详情面板；分栏可拖动或至少可折叠
- [ ] 无死白/死黑大块空白；空态有明确文案与图标

## 4. 终端质感（Codex 特征）

- [ ] 命令式输入（如 Analyze public PR）带 > 前缀与 mono 字体
- [ ] 流式输出（Notebook/Agent 时间线）有等宽字体 + step 编号感
- [ ] 状态变化即时可见（运行中 spinner / 完成 check / 失败 cross，不用弹跳动画）

## 5. 动效与一致性

- [ ] 时长 ≤ 180ms；无弹簧/回弹；尊重 prefers-reduced-motion
- [ ] 同类组件（徽标、按钮、卡片）在所有页面外观一致
- [ ] 图标全库统一线性风格（lucide），圆角统一（面板 8px / 控件 6px）
