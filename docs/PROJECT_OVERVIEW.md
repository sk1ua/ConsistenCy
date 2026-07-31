# 项目概览

ConsistenCy 是一个基于证据的多信号 PR 审查助手。它通过确定性专家分析器、本地证据检索、压缩后的 Evidence Pack 和加权共识，帮助审查者优先查看高风险文件。

## 审查流程

```text
git diff -> 项目历史基线 -> 证据检索 -> Evidence Pack -> 确定性分析器 -> 加权共识 -> 审查者移交
```

Evidence Retrieval 不是 Agent。它负责为专家分析器和审查者移交提供上下文。

## 专家信号

| 信号 | 用途 |
| --- | --- |
| `style` | 命名、文档、约定漂移 |
| `structural` | import、耦合、模块边界 |
| `semantic` | AST、API、控制流代理变化 |
| `duplication` | 克隆和重复实现风险 |
| `security` | 不安全模式和安全覆盖提示 |
| `evolution` | churn、热点、ownership、历史风险 |

## 证据检索

检索层是确定性、本地化的。它使用变更 hunk、文件片段、baseline/history hint、agent finding、security finding、跨文件 call-site hint、ownership hint 和本地相似度评分。

它不需要向量数据库，也不需要外部 API。

## 产品组成

- `apps/api`：GitHub App webhook API、worker、SQLite 持久化。
- `apps/web`：React/Vite 仪表盘。
- `packages/schema`：共享 TypeScript zod 契约。
- `engine`：Python 分析器、检索和协议 runner（通过 JSON-over-stdio 与 TypeScript 编排层交互）。
