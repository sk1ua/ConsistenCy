# 项目概览

ConsistenCy 是一个 GitHub Pull Request 审查平台。它的产品价值不是替代审查者下结论，而是把变更、历史、确定性分析、Agent 运行和发布状态组织成一份可追溯的证据包，让审查者自己更快地下结论。

## 为什么拆成两层

编排是不确定的：Webhook 会重放，GitHub 会限流，LLM 会超时。分析必须是确定的：同一份代码必须算出同样的风险。ConsistenCy 按这个差异切分系统：

- **TypeScript 编排服务**处理 Webhook、GitHub API、Job 状态、临时工作区、LLM provider、报告持久化和 GitHub 发布。这一层允许失败、重试和独立演进。
- **Python 引擎**只处理确定性代码分析、证据检索和分析报告生成，通过 JSON-over-stdio 与 TypeScript 通信。这一层不访问 GitHub、不依赖 LLM key，同样的输入永远产生同样的输出。

这条边界带来两个直接收益：分析层的输入、输出和错误行为可以被测试锁定；MockLLM 可以在完整流程中替换真实模型，编排行为因此也能进 CI。

## 一次审查如何流动

1. GitHub Webhook 或本地 API 创建 Job。
2. ReviewWorker 准备 PR context 和隔离工作区。
3. Python Engine 返回确定性信号与 Evidence Pack。
4. Planner、可选 LLM Agents、Compose 和 Synthesizer 形成 ReviewReport。
5. 报告在 SQLite 中持久化，并以原子事务写入 Outbox。
6. PublishWorker 获得租约后发布或幂等更新 GitHub 评论。

发布失败进入 `publish_failed`，不会抹掉已完成的报告。完整生命周期图与发布状态机见[架构](architecture.md)。

## 术语边界

- **Demo Mode**：固定 seed、MockLLM、无外部 GitHub 请求，适合快速体验和 E2E。
- **Verified public source**：由公开 GitHub PR 快照导入的事实，页面会分开显示 GitHub 观测值和 ConsistenCy 模型推导值。
- **Evidence Pack**：供分析器和审查编排使用的压缩证据集合，不等于最终缺陷结论。
- **弱标签评估**：用公开 Review 文件位置近似审查者关注点，只能评估排序重合度。

## 继续阅读

- 使用：[Demo](demo.md) · [GitHub App 设置](GITHUB_APP_SETUP.md) · [HTTP API](api.md)
- 深入：[架构](architecture.md) · [输出 Schema](output_schema.md) · [安全](security.md)
- 评估：[评估边界](EVALUATION.md)
