# Repository Review Notebook

Repository Review Notebook 是默认打开的全页来源驱动研究空间，帮助开发者理解一个或多个 PR 的影响范围，而不是替代代码执行环境。

## 运行模式

| 模式 | 来源 | LLM | 副作用 |
| --- | --- | --- | --- |
| Demo Mode | 固定 seed 和本地快照 | MockLLM | 不访问 GitHub、不发布评论 |
| Public Read — Anonymous | 公开 GitHub API 和匿名 clone | Mock、DeepSeek 或 OpenAI | 只创建分析 Job，不发布评论 |
| Public Read — PAT | 服务端配置的本地只读 PAT | Mock、DeepSeek 或 OpenAI | 只创建分析 Job，不发布评论 |
| Webhook Review | GitHub App installation token | Mock、DeepSeek 或 OpenAI | 继续使用既有发布策略 |

## 来源边界

Notebook 是仓库级空间，但证据不是无边界的。每个 source 记录：

```text
repository + pull request number + jobId + baseSha + headSha
```

回答默认使用当前选中的 source；跨 PR 查询必须显式传入 `sourceJobIds`。Citation 还会记录文件、起止行、head SHA 和 excerpt，因此不同 PR 或不同 head SHA 的内容不会自动混合。

## 只读工具

- `search_repository`：按路径、符号和自然语言片段检索 SHA 绑定快照；
- `read_file`：读取有限行区间；
- `get_diff` / `get_base_file`：读取 PR 与 base 文件；
- `get_evidence_pack` / `get_review_findings`：复用确定性报告；
- `generate_patch`：返回 unified diff 文本，不写文件。

仓库索引按 `repository + headSha` 懒加载，跳过 `.git`、依赖目录、构建产物、缓存、二进制和 Secret 路径。索引缓存不会覆盖其他 SHA。

## 对话与卡片

`POST /notebooks/:id/messages` 使用 SSE。UI 会显示 source selection、tool started/result、citation、text delta、usage 和 completed/degraded 状态，但不会显示原始 prompt 或密钥。

助手消息和卡片使用安全的 Markdown/GFM 渲染，原始 HTML 不会执行。用户也可以让对话把审查目标整理成待审核的 `AnalysisSpec` 草案；草案只能选择 `style`、`structural`、`semantic`、`duplication`、`security`，不会生成或执行临时 Python。

四类卡片：

1. **Change Map**：文件和目录变更范围；
2. **Architecture Impact**：模块、入口和调用关系的证据化说明；
3. **Risk Brief**：确定性风险信号和 findings 汇总；
4. **Fix Plan**：优先级、建议测试范围和未应用的补丁文本。

引用不足时，Notebook 必须明确回答“当前上下文无法确认”。LLM 超时、限流或非法结果不会影响已完成的 ReviewReport；可由确定性数据支持的内容会标明降级来源，无法确认的模型结论不会伪造成成功结果。

## 配置

```env
CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED=true
CONSISTENCY_NOTEBOOK_ENABLED=true
CONSISTENCY_NOTEBOOK_MAX_TOOL_CALLS=8
CONSISTENCY_NOTEBOOK_MAX_CONTEXT_TOKENS=16000
CONSISTENCY_NOTEBOOK_INDEX_MAX_BYTES=67108864
GITHUB_PUBLIC_READ_TOKEN=
```

`GITHUB_PUBLIC_READ_TOKEN` 留空表示匿名公开读取；可通过 Settings 录入并存入本地加密配置，保存后 API 只返回布尔配置状态，不回显 token。健康接口显示 `anonymous`、`pat` 或 `disabled`。LLM provider 切换到 DeepSeek/OpenAI 后，Settings 会显示 provider/model，重新启动后生效。
