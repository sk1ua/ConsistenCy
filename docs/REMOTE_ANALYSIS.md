# 远程与 GitHub PR 分析

ConsistenCy V2 通过 TypeScript 编排层 (`apps/api`) 统一处理 GitHub PR 分析。

当接收到 GitHub Webhook 或触发审查任务时，TypeScript API 会在临时工作区中拉取代码变更，并调用 Python 分析引擎 (`engine`) 进行多信号分析，最后通过 Outbox 机制发布 GitHub 评论。

在本地直接运行无 Git 的示例分析可使用：

```bash
python examples/multi_agent_demo.py
```
