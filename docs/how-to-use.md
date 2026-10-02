# 这个项目怎么用（v4 终端版）

一句话：**装在仓库旁边，在终端里对自己或别人的代码改动跑一次"有证据的审查"，输出报告或 JSON。**

这台机器上已经配好了，直接照下面敲就行。其它机器从 [getting-started.md](getting-started.md) 开始装。

---

## 0. 先确认装好了

```powershell
cd D:\sk1ua\python\consistency-v4

# 让终端用 Node 22（本项目要求 >=22.19 <23）
$env:PATH = "C:\Users\15857\AppData\Local\Temp\consistency-node22;" + $env:PATH

# 让 CLI 知道用哪个 Python（确定性证据层靠它）
$env:CONSISTENCY_PYTHON_PATH = "D:\sk1ua\python\consistency-v4\.venv\Scripts\python.exe"

npm run verify:runtime     # 应输出 Baseline runtime verified: Node v22.23.2, Python 3.12.10
npm run consistency -- help
```

`npm run consistency -- <参数>` 里那个 `--` 是 npm 的传参语法，**必须留着**，否则参数会被 npm 自己吃掉。

---

## 1. 入口就一个命令

```
npm run consistency -- review [选项]
```

也可以写短一点：`npm run review` 等价于 `npm run consistency -- review`。

`review` 有两种用法，**默认是第一种**：

| 你想审什么 | 怎么敲 |
|---|---|
| 一个仓库里**还没提交**的改动 | 不传区间参数 |
| 两个提交之间的改动 | `--base <起点> --head <终点>` |

```powershell
# 审查当前目录这个仓库的未提交改动
npm run review

# 审查别的仓库
npm run review -- --repo D:\path\to\some\repo

# 审查某两个提交之间（--base 会自动补 --head HEAD）
npm run review -- --repo D:\path\to\repo --base main
npm run review -- --base v1.2.0 --head v1.3.0
```

只传 `--head` 不传 `--base` 会直接报错退出 2（意思是"你要审哪一段"没交代清楚）。

---

## 2. 常用选项

| 选项 | 作用 |
|---|---|
| `--repo <路径>` | 要审的仓库，默认当前目录 |
| `--base <ref>` / `--head <ref>` | 审查区间；只给 `--base` 会自动补 `HEAD` |
| `--json` | 输出机器可读 JSON，用来接别的工具 |
| `--verbose` | 多说一些过程信息 |
| `--limit <n>` | 限制审多少个文件 |
| `--all` | 不按变更集限制 |
| `--no-color` / `--color` | 关掉/强制彩色（管道里默认关） |
| `--no-memory` | 本次不读写持久化知识库（等价于 `CONSISTENCY_NO_MEMORY=1`） |
| `--language <zh-CN\|en-US>` | 报告语言 |
| `--threshold <critical\|high\|medium\|low\|info>` | 退出码阈值，默认 `low` |
| `--provider <名>` / `--model <名>` | 临时换 LLM 供应商/模型 |

```powershell
npm run review -- --json > 报告.json      # 接流程用
npm run review -- --repo D:\repo --limit 20 --no-color
npm run review -- --no-memory             # 本次不读写知识记忆
```

默认会复用安装根目录下 `.consistency/cli/knowledge/<repo>.sqlite` 的历史记忆，并在完成后记录 findings。`--no-memory` 或环境变量 `CONSISTENCY_NO_MEMORY=1` 会同时关闭历史读取、知识索引更新和 `record_review` 写回；已存在的知识库不会被打开或修改，不存在时也不会创建。只有环境值 `1` 关闭记忆，`0`/未设置保持默认；CLI flag 始终优先关闭。它不删除旧记忆，不关闭正常的确定性分析或报告输出，也不意味着所有 `.consistency/` 产物都不落盘。

---

## 3. 它靠什么工作（第一次跑之前要知道的两件事）

1. **要配一个真 LLM**。没配的话会在开跑前停下，并告诉你去敲 `npm run setup` 或 `npm run config -- set llm.provider deepseek`。产品运行时**不允许 mock**，这是仓库的硬规矩。
2. **要有 Python 3.12 + 本仓库的 `.venv`**（确定性证据层）。上面第 0 步的 `CONSISTENCY_PYTHON_PATH` 就是给它指路；没设的话 CLI 会去 `<仓库根>/.venv` 找。

配置只存本地，落在 `.consistency/` 下（`config.json` + 加密的 `secrets.enc.json`）。

---

## 4. 看懂报告（这决定你会不会误信它）

报告里有两个**互不相同、永不合并**的风险数字，别把它们当成一个：

- **`score` / `riskLevel`**：确定性静态分析给出的分数与档位。
- **`staticRiskLabel`**：静态标签，不是“没意见 = 一致”。未分析或分析失败显示 `Not Analyzed (原因)`，不会显示 `Consistent`。只有全部被分析文件都没有基线时才显示 `No Baseline`。混合变更按有基线的文件计分，并注明新增文件数（例如 `Moderate Drift / 1 new file`）。
- **`riskBand`**：最终 findings 的严重度带。

`CONSISTENCY_LEAN=1` 是默认关闭的瘦审查：只跑 Correctness 和 Consistency，不调用 Planner。Consistency 的每条意见必须引用仓库里已经存在的先例，并通过确定性代码校验；对不上的意见会被丢掉。未设置、`0` 和其他值都保持原来的六专家审查。

`CONSISTENCY_SCORE_RUBRIC=1` 是另一个默认关闭的开关。打开后评分请求会看到编号后的改动代码，已核实的惯例偏离给高分，泛泛的测试建议和把预期改动当成破坏的意见会被压低，单文件上限从 3 提到 4。未设置、`0` 和其他值保持原来的评分说明和上限。

另外有一段**约束块**会一直存在，它不是凑字数：

- `[!]` = 这部分**本次没检查**（不是检查通过了）。
- `[~]` = 检查了，但**证据链不完整**。
- 没有覆盖记录时，**不会**给你打绿勾，只写"本次审查未记录覆盖范围"。

设计原则是：**没检查到什么，比检查到了什么更显眼。**

---

## 5. 退出码（想接 CI 必须看这段）

| 码 | 含义 | 能当闸门吗 |
|---|---|---|
| `0` | 跑完了，没有 finding 达到阈值 | 能 |
| `1` | 跑完了，有 finding 达到阈值 | 能（用 `--threshold` 调灵敏度） |
| `2` | **没跑成**，或本次审查**覆盖不完整** | **不能**——它不是"通过"，是"没结论" |

判定点只有一个：`apps/cli/src/report.ts:425` 的 `exitCodeFor()`。

---

## 6. 日常三条命令

```powershell
# 1) 提交前自查：看自己刚写的东西有没有问题
npm run review

# 2) 给别人看机器结论
npm run review -- --json > review.json

# 3) 想知道服务端那套（HTTP daemon）能不能起
npm run dev:api
```

`npm run config -- doctor` 用来体检配置（会告诉你 GitHub App 没配、Web URL 是否在允许来源里等）。

---

## 7. 现在**没有**的东西（免得你找半天）

- 没有网页界面，没有桌面应用——v4 把这些全删了，只剩终端和（无界面的）HTTP daemon。见 [delivery-readiness.md](delivery-readiness.md)。
- Notebook 只有服务端 API，仓库里不带界面。
- 一次性 CLI 进程**不持久化任务、报告或快照**：任务放在内存队列里，要留完整报告请用 `--json > 文件` 或 HTTP daemon。项目知识记忆默认会另存到 `.consistency/cli/knowledge/<repo>.sqlite`；不想读写它就用 `--no-memory` 或 `CONSISTENCY_NO_MEMORY=1`。
- CLI 没有"取消"入口：中断它就是杀进程。
- GitHub App 没配：本地审查和公开 PR 分析能用，webhook 驱动的 PR 与自动评论不能用。配置见 [GITHUB_APP_SETUP.md](GITHUB_APP_SETUP.md)。

---

## 8. 出问题先看这里

- 报「Python 3.12.x required」→ `CONSISTENCY_PYTHON_PATH` 没设或指错（`.venv\Scripts\python.exe`）。
- 报「没有可用的 LLM provider」→ 敲 `npm run config -- set llm.provider deepseek`，再设 `DEEPSEEK_API_KEY`。
- 报「看起来不是 git 仓库（缺 .git）」→ `--repo` 指到了非仓库目录，或者你还没 `git init`。
- 报「未知参数」→ 检查 `--` 有没有丢。完整清单：`npm run consistency -- review --help`。
- 更多排错（含逐字报错）见 [getting-started.md](getting-started.md)。
