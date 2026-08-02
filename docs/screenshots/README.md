# 截图与证据资产

这些图片由 `npm run capture:screenshots` 从当前 React 页面生成，不是设计稿。

| 文件 | 页面 | 来源标签 |
| --- | --- | --- |
| `dashboard-demo-desktop.png` | Dashboard | Demo Mode / 固定 seed / MockLLM |
| `dashboard-demo-mobile.png` | Dashboard | Demo Mode / 移动端布局 |
| `report-demo-desktop.png` | Report | Demo Mode / Findings、Evidence、Agent runs |
| `report-notebook-demo-desktop.png` | Report + Repository Notebook | Demo Mode / SSE 对话、工具状态、引用和分析卡片 |
| `settings-demo-desktop.png` | Settings | Demo Mode / 本地运行配置脱敏 |
| `real-data-espnet-pr6327-desktop.png` | Real Data | Verified public source / `espnet/espnet #6327` |
| `dashboard-demo-zh-desktop.png` | Dashboard (中文) | Demo Mode / CJK 界面与代码等宽字体核验 |

Dashboard 图片包含公开 PR URL 输入入口；Demo 图片不代表外部 GitHub 发布成功。Notebook 图片使用固定 Demo source 和 MockLLM，展示当前真实 UI 的流式交互，不伪装成 Live LLM。公开数据图片只展示抓取到的 GitHub 事实、ConsistenCy 模型推导值和弱标签评估，三者在页面中分栏标注。

截图不得包含绝对本地路径、API token、私钥或无必要的 App ID；Settings 页只展示脱敏后的配置摘要，数据库路径等本地信息不回显。
